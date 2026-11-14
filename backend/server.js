import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import next from 'next';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const app = express();
const port = Number(process.env.PORT || 10000);
const frontendDir = fileURLToPath(new URL('../frontend', import.meta.url));
const nextApp = next({ dev: process.env.NODE_ENV !== 'production', dir: frontendDir });
const nextHandler = nextApp.getRequestHandler();
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',').map(v => v.trim()) : true }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 5 } });
const fail = (res, status, message) => res.status(status).json({ error: message });
const db = res => { if (!supabase) { fail(res, 503, 'Supabase is not configured'); return false; } return true; };
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);

async function authenticate(req, res, nextMiddleware) {
  try {
    if (!db(res)) return;
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return fail(res, 401, 'Authentication required');
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return fail(res, 401, 'Invalid or expired session');
    const { error: profileError } = await supabase.from('profiles').upsert({
      id: data.user.id,
      display_name: data.user.user_metadata?.display_name || data.user.email?.split('@')[0] || 'Customer'
    }, { onConflict: 'id', ignoreDuplicates: true });
    if (profileError) {
      console.error('Profile initialization failed:', profileError.message);
      return fail(res, 500, 'Could not initialize account profile');
    }
    req.user = data.user;
    return nextMiddleware();
  } catch (error) {
    console.error('Authentication error:', error);
    return fail(res, 401, 'Authentication failed');
  }
}
async function vendorFor(userId) {
  return supabase.from('vendors').select('*').eq('user_id', userId).maybeSingle();
}
async function isAdmin(userId) {
  const { data } = await supabase.from('profiles').select('role').eq('id', userId).maybeSingle();
  return data?.role === 'admin';
}
async function requireAdmin(req, res, nextMiddleware) {
  if (!await isAdmin(req.user.id)) return fail(res, 403, 'Admin only');
  return nextMiddleware();
}
async function requireVendor(req, res, nextMiddleware) {
  const { data: vendor, error } = await vendorFor(req.user.id);
  if (error || !vendor) return fail(res, 403, 'Vendor account not found');
  if (vendor.status !== 'approved') return fail(res, 403, 'Vendor account is not approved');
  req.vendor = vendor;
  return nextMiddleware();
}
async function telegram(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram storage is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, payload);
  const json = await response.json();
  if (!json.ok) throw new Error(json.description || 'Telegram request failed');
  return json.result;
}
async function uploadToTelegram(file) {
  const channel = process.env.TELEGRAM_CHANNEL_ID;
  if (!channel) throw new Error('Telegram image storage is not configured');
  const form = new FormData();
  form.append('chat_id', channel);
  form.append('photo', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'product.jpg');
  const result = await telegram('sendPhoto', { method: 'POST', body: form });
  return { messageId: String(result.message_id), fileId: result.photo?.at(-1)?.file_id || null };
}
async function deleteTelegramMessage(messageId) {
  if (!process.env.TELEGRAM_CHANNEL_ID) return;
  try {
    await telegram('deleteMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHANNEL_ID, message_id: Number(messageId) })
    });
  } catch (error) { console.warn('Telegram cleanup failed:', error.message); }
}
function publicProduct(product) {
  return {
    ...product,
    product_images: (product.product_images || []).map(image => ({
      id: image.id, sort_order: image.sort_order,
      image_url: image.file_id ? `/api/images/${encodeURIComponent(image.file_id)}` : null
    }))
  };
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'EcomStore', database: Boolean(supabase) }));

// Telegram image proxy keeps bot credentials and file paths on the server.
app.get('/api/images/:fileId', async (req, res) => {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) return fail(res, 503, 'Image storage is not configured');
    const fileId = clean(req.params.fileId, 2048);
    if (!fileId) return fail(res, 400, 'Invalid image ID');
    const file = await telegram('getFile', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: fileId })
    });
    const imageResponse = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
    if (!imageResponse.ok) return fail(res, 502, 'Could not retrieve image');
    res.set('Content-Type', imageResponse.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return res.send(Buffer.from(await imageResponse.arrayBuffer()));
  } catch (error) {
    console.error('Image proxy error:', error.message);
    return fail(res, 502, 'Image service unavailable');
  }
});

// Public catalogue.
app.get('/api/categories', async (_req, res) => {
  if (!db(res)) return;
  const { data, error } = await supabase.from('products').select('category').eq('status', 'active');
  if (error) return fail(res, 500, 'Could not load categories');
  res.json({ data: [...new Set((data || []).map(row => row.category).filter(Boolean))].sort() });
});
app.get('/api/products', async (req, res) => {
  if (!db(res)) return;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 24));
  const q = clean(req.query.q, 100);
  const category = clean(req.query.category, 80);
  let query = supabase.from('products').select('id,title,description,price,stock,category,created_at,vendor_id,product_images(id,file_id,sort_order),vendors!inner(store_name,status)', { count: 'exact' })
    .eq('status', 'active').eq('vendors.status', 'approved').order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  if (q) query = query.ilike('title', `%${q.replace(/[%_]/g, '')}%`);
  if (category) query = query.eq('category', category);
  const { data, error, count } = await query;
  if (error) { console.error(error); return fail(res, 500, 'Could not load products'); }
  res.json({ data: (data || []).map(publicProduct), page, limit, total: count || 0 });
});
app.get('/api/products/:id', async (req, res) => {
  if (!db(res)) return;
  const { data, error } = await supabase.from('products')
    .select('*,product_images(id,file_id,sort_order),vendors!inner(store_name,status)')
    .eq('id', req.params.id).eq('status', 'active').eq('vendors.status', 'approved').maybeSingle();
  if (error || !data) return fail(res, 404, 'Product not found');
  res.json({ data: publicProduct(data) });
});

// Profile and vendor onboarding.
app.get('/api/me', authenticate, async (req, res) => {
  const [{ data: profile }, { data: vendor }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', req.user.id).maybeSingle(),
    vendorFor(req.user.id)
  ]);
  res.json({ data: { user: { id: req.user.id, email: req.user.email }, profile, vendor, isAdmin: profile?.role === 'admin' } });
});
app.patch('/api/me', authenticate, async (req, res) => {
  const patch = {};
  if (req.body.display_name !== undefined) patch.display_name = clean(req.body.display_name, 100);
  if (req.body.phone !== undefined) patch.phone = clean(req.body.phone, 30);
  if (patch.display_name !== undefined && patch.display_name.length < 2) return fail(res, 400, 'Name must be at least 2 characters');
  const { data, error } = await supabase.from('profiles').update(patch).eq('id', req.user.id).select().single();
  if (error) return fail(res, 400, 'Could not update profile');
  res.json({ data });
});
app.post('/api/vendors/register', authenticate, async (req, res) => {
  const store_name = clean(req.body.store_name, 80);
  const description = clean(req.body.description, 1000);
  if (store_name.length < 2) return fail(res, 400, 'Store name must be 2–80 characters');
  const { data: existing } = await vendorFor(req.user.id);
  if (existing) return fail(res, 409, 'Vendor application already exists');
  const { data, error } = await supabase.from('vendors').insert({ user_id: req.user.id, store_name, description }).select().single();
  if (error) return fail(res, 400, 'Could not submit vendor application');
  await supabase.from('profiles').update({ role: 'vendor' }).eq('id', req.user.id);
  res.status(201).json({ data });
});

// Vendor product management.
app.get('/api/vendor/products', authenticate, async (req, res) => {
  const { data: vendor } = await vendorFor(req.user.id);
  if (!vendor) return fail(res, 403, 'Vendor account not found');
  const { data, error } = await supabase.from('products')
    .select('*,product_images(id,file_id,telegram_message_id,sort_order)')
    .eq('vendor_id', vendor.id).order('created_at', { ascending: false });
  if (error) return fail(res, 500, 'Could not load vendor products');
  res.json({ data: (data || []).map(publicProduct), vendor });
});
app.post('/api/products', authenticate, requireVendor, async (req, res) => {
  const title = clean(req.body.title, 160);
  const description = clean(req.body.description, 5000);
  const category = clean(req.body.category || 'General', 80);
  const price = Number(req.body.price);
  const stock = Number(req.body.stock);
  if (title.length < 2 || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) return fail(res, 400, 'Invalid title, price or stock');
  const status = process.env.AUTO_APPROVE_PRODUCTS === 'true' ? 'active' : 'pending';
  const { data, error } = await supabase.from('products')
    .insert({ vendor_id: req.vendor.id, title, description, category, price, stock, status }).select().single();
  if (error) return fail(res, 400, 'Could not create product');
  res.status(201).json({ data });
});
app.patch('/api/products/:id', authenticate, async (req, res) => {
  const { data: vendor } = await vendorFor(req.user.id);
  const admin = await isAdmin(req.user.id);
  const { data: existing } = await supabase.from('products').select('id,vendor_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return fail(res, 404, 'Product not found');
  if (!admin && (!vendor || vendor.id !== existing.vendor_id)) return fail(res, 403, 'Not allowed');
  const patch = {};
  for (const key of ['title','description','category']) if (req.body[key] !== undefined) patch[key] = clean(req.body[key], key === 'description' ? 5000 : key === 'title' ? 160 : 80);
  if (req.body.price !== undefined) patch.price = Number(req.body.price);
  if (req.body.stock !== undefined) patch.stock = Number(req.body.stock);
  if (patch.title !== undefined && patch.title.length < 2) return fail(res, 400, 'Invalid title');
  if (patch.price !== undefined && (!Number.isFinite(patch.price) || patch.price < 0)) return fail(res, 400, 'Invalid price');
  if (patch.stock !== undefined && (!Number.isInteger(patch.stock) || patch.stock < 0)) return fail(res, 400, 'Invalid stock');
  if (!Object.keys(patch).length) return fail(res, 400, 'No valid fields supplied');
  if (!admin) patch.status = process.env.AUTO_APPROVE_PRODUCTS === 'true' ? 'active' : 'pending';
  patch.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('products').update(patch).eq('id', existing.id).select().single();
  if (error) return fail(res, 400, 'Could not update product');
  res.json({ data });
});
app.delete('/api/products/:id', authenticate, async (req, res) => {
  const [{ data: vendor }, admin] = await Promise.all([vendorFor(req.user.id), isAdmin(req.user.id)]);
  const { data: product } = await supabase.from('products').select('id,vendor_id,product_images(id,telegram_message_id)').eq('id', req.params.id).maybeSingle();
  if (!product) return fail(res, 404, 'Product not found');
  if (!admin && (!vendor || product.vendor_id !== vendor.id)) return fail(res, 403, 'Not allowed');
  const { count: soldCount } = await supabase.from('order_items').select('id', { count: 'exact', head: true }).eq('product_id', product.id);
  if ((soldCount || 0) > 0) {
    const { error } = await supabase.from('products').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', product.id);
    if (error) return fail(res, 500, 'Could not archive product with order history');
    return res.json({ success: true, archived: true });
  }
  const { error } = await supabase.from('products').delete().eq('id', product.id);
  if (error) return fail(res, 500, 'Could not delete product');
  for (const img of product.product_images || []) await deleteTelegramMessage(img.telegram_message_id);
  res.json({ success: true, archived: false });
});
app.post('/api/products/:id/images', authenticate, requireVendor, upload.array('images', 5), async (req, res) => {
  const { data: product } = await supabase.from('products').select('id').eq('id', req.params.id).eq('vendor_id', req.vendor.id).maybeSingle();
  if (!product) return fail(res, 404, 'Product not found');
  const files = req.files || [];
  if (!files.length || files.some(file => !file.mimetype.startsWith('image/'))) return fail(res, 400, 'Choose image files');
  const { count } = await supabase.from('product_images').select('*', { count: 'exact', head: true }).eq('product_id', product.id);
  if ((count || 0) + files.length > 5) return fail(res, 400, 'Maximum 5 images per product');
  const uploaded = [];
  try {
    for (const file of files) uploaded.push(await uploadToTelegram(file));
    const rows = uploaded.map((item, index) => ({ product_id: product.id, telegram_message_id: item.messageId, file_id: item.fileId, sort_order: (count || 0) + index }));
    const { data, error } = await supabase.from('product_images').insert(rows).select();
    if (error) throw error;
    res.status(201).json({ data: (data || []).map(publicProduct) });
  } catch (error) {
    for (const item of uploaded) await deleteTelegramMessage(item.messageId);
    return fail(res, 502, error.message || 'Image upload failed');
  }
});
app.delete('/api/products/:id/images/:imageId', authenticate, requireVendor, async (req, res) => {
  const { data: product } = await supabase.from('products').select('id').eq('id', req.params.id).eq('vendor_id', req.vendor.id).maybeSingle();
  if (!product) return fail(res, 404, 'Product not found');
  const { data: row } = await supabase.from('product_images').select('*').eq('id', req.params.imageId).eq('product_id', product.id).maybeSingle();
  if (!row) return fail(res, 404, 'Image not found');
  const { error } = await supabase.from('product_images').delete().eq('id', row.id);
  if (error) return fail(res, 500, 'Could not delete image');
  await deleteTelegramMessage(row.telegram_message_id);
  res.json({ success: true });
});

// Checkout uses one atomic Postgres function; never trust prices sent by the browser.
app.post('/api/orders', authenticate, async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items.map(item => ({
    product_id: clean(item.product_id, 60), quantity: Number(item.quantity)
  })) : [];
  if (!items.length || items.length > 50 || items.some(item => !item.product_id || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99)) return fail(res, 400, 'Invalid cart items');
  const args = {
    p_customer_id: req.user.id,
    p_customer_name: clean(req.body.customer_name, 100),
    p_customer_phone: clean(req.body.customer_phone, 30),
    p_delivery_address: clean(req.body.delivery_address, 1000),
    p_delivery_note: clean(req.body.delivery_note, 500),
    p_payment_method: clean(req.body.payment_method, 30),
    p_items: items
  };
  const { data: orderId, error } = await supabase.rpc('place_marketplace_order', args);
  if (error) {
    console.error('Checkout rejected:', error.message);
    return fail(res, 400, error.message.replace(/^.*?: /, '').slice(0, 220));
  }
  const { data: order } = await supabase.from('orders').select('*,order_items(*,products(title))').eq('id', orderId).single();
  res.status(201).json({ data: order });
});
app.get('/api/orders', authenticate, async (req, res) => {
  const { data, error } = await supabase.from('orders')
    .select('*,order_items(id,quantity,unit_price,products(id,title),vendors(store_name))')
    .eq('customer_id', req.user.id).order('created_at', { ascending: false });
  if (error) return fail(res, 500, 'Could not load orders');
  res.json({ data: data || [] });
});

// Vendor order queue; vendor can only change fulfilment status for their own orders.
app.get('/api/vendor/orders', authenticate, async (req, res) => {
  const { data: vendor } = await vendorFor(req.user.id);
  if (!vendor) return fail(res, 403, 'Vendor account not found');
  const { data: items, error } = await supabase.from('order_items')
    .select('id,order_id,product_id,quantity,unit_price,products(title),orders(id,status,total,customer_name,customer_phone,delivery_address,delivery_note,payment_method,payment_status,created_at)')
    .eq('vendor_id', vendor.id).order('created_at', { ascending: false, referencedTable: 'orders' });
  if (error) return fail(res, 500, 'Could not load vendor orders');
  res.json({ data: items || [], vendor });
});
app.patch('/api/vendor/orders/:orderId', authenticate, async (req, res) => {
  const { data: vendor } = await vendorFor(req.user.id);
  if (!vendor || vendor.status !== 'approved') return fail(res, 403, 'Approved vendor required');
  const status = clean(req.body.status, 30);
  if (!['processing','shipped','completed','cancelled'].includes(status)) return fail(res, 400, 'Invalid order status');
  const { data: items } = await supabase.from('order_items').select('id').eq('order_id', req.params.orderId).eq('vendor_id', vendor.id).limit(1);
  if (!items?.length) return fail(res, 404, 'Order not found for this store');
  const { data, error } = await supabase.from('orders').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.orderId).select().single();
  if (error) return fail(res, 400, 'Could not update order');
  res.json({ data });
});

// Admin operations.
app.get('/api/admin/overview', authenticate, requireAdmin, async (_req, res) => {
  const [vendors, products, orders, customers] = await Promise.all([
    supabase.from('vendors').select('id,status', { count: 'exact' }),
    supabase.from('products').select('id,status', { count: 'exact' }),
    supabase.from('orders').select('id,status,total', { count: 'exact' }),
    supabase.from('profiles').select('id', { count: 'exact' }).eq('role','customer')
  ]);
  res.json({ data: {
    vendors: vendors.count || 0, pendingVendors: (vendors.data || []).filter(x => x.status === 'pending').length,
    products: products.count || 0, pendingProducts: (products.data || []).filter(x => x.status === 'pending').length,
    orders: orders.count || 0, customers: customers.count || 0,
    revenue: (orders.data || []).filter(x => ['paid','processing','shipped','completed'].includes(x.status)).reduce((s,x) => s + Number(x.total || 0), 0)
  } });
});
app.get('/api/admin/vendors', authenticate, requireAdmin, async (_req, res) => {
  const { data, error } = await supabase.from('vendors').select('*,profiles(display_name,phone)').order('created_at', { ascending: false });
  if (error) return fail(res, 500, 'Could not load vendors');
  res.json({ data });
});
app.patch('/api/admin/vendors/:id', authenticate, requireAdmin, async (req, res) => {
  const status = clean(req.body.status, 20);
  if (!['approved','rejected','blocked','pending'].includes(status)) return fail(res, 400, 'Invalid vendor status');
  const { data, error } = await supabase.from('vendors').update({ status }).eq('id', req.params.id).select().single();
  if (error) return fail(res, 400, 'Could not update vendor');
  if (status === 'approved') await supabase.from('profiles').update({ role: 'vendor' }).eq('id', data.user_id);
  res.json({ data });
});
app.get('/api/admin/products', authenticate, requireAdmin, async (_req, res) => {
  const { data, error } = await supabase.from('products').select('*,vendors(store_name,status),product_images(id,file_id,sort_order)').order('created_at', { ascending: false });
  if (error) return fail(res, 500, 'Could not load products');
  res.json({ data: (data || []).map(publicProduct) });
});
app.patch('/api/admin/products/:id', authenticate, requireAdmin, async (req, res) => {
  const status = clean(req.body.status, 20);
  if (!['active','pending','rejected','archived'].includes(status)) return fail(res, 400, 'Invalid product status');
  const { data, error } = await supabase.from('products').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return fail(res, 400, 'Could not update product');
  res.json({ data });
});
app.get('/api/admin/orders', authenticate, requireAdmin, async (_req, res) => {
  const { data, error } = await supabase.from('orders')
    .select('*,profiles(display_name),order_items(quantity,unit_price,products(title),vendors(store_name))')
    .order('created_at', { ascending: false }).limit(200);
  if (error) return fail(res, 500, 'Could not load orders');
  res.json({ data: data || [] });
});
app.patch('/api/admin/orders/:id', authenticate, requireAdmin, async (req, res) => {
  const status = clean(req.body.status, 20);
  const payment_status = req.body.payment_status === undefined ? undefined : clean(req.body.payment_status, 30);
  if (!['pending','paid','processing','shipped','completed','cancelled'].includes(status)) return fail(res, 400, 'Invalid order status');
  if (payment_status !== undefined && !['unpaid','pending_verification','paid','refunded'].includes(payment_status)) return fail(res, 400, 'Invalid payment status');
  const patch = { status, updated_at: new Date().toISOString() };
  if (payment_status !== undefined) patch.payment_status = payment_status;
  const { data, error } = await supabase.from('orders').update(patch).eq('id', req.params.id).select().single();
  if (error) return fail(res, 400, 'Could not update order');
  res.json({ data });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return fail(res, 400, error.message);
  console.error('EcomStore request error:', error);
  return fail(res, 500, 'Internal server error');
});

await nextApp.prepare();
app.use((req, res) => nextHandler(req, res));
app.listen(port, () => console.log(`EcomStore full-stack service listening on ${port}`));
