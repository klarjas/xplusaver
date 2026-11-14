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
const supabase = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',').map(v => v.trim()) : true }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 5 } });
const fail = (res, status, message) => res.status(status).json({ error: message });
const db = (res) => {
  if (!supabase) { fail(res, 503, 'Supabase is not configured'); return false; }
  return true;
};

async function authenticate(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token || !supabase) return fail(res, 401, 'Authentication required');
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return fail(res, 401, 'Invalid or expired session');
    req.user = data.user;
    next();
  } catch { return fail(res, 401, 'Authentication failed'); }
}
async function vendorFor(userId) {
  return supabase.from('vendors').select('*').eq('user_id', userId).maybeSingle();
}
async function requireVendor(req, res, next) {
  const { data: vendor, error } = await vendorFor(req.user.id);
  if (error || !vendor) return fail(res, 403, 'Vendor account not found');
  if (vendor.status !== 'approved') return fail(res, 403, 'Vendor account is not approved');
  req.vendor = vendor;
  next();
}
async function isAdmin(userId) {
  const { data } = await supabase.from('profiles').select('role').eq('id', userId).maybeSingle();
  return data?.role === 'admin';
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
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const channel = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !channel) throw new Error('Telegram image storage is not configured');
  const form = new FormData();
  form.append('chat_id', channel);
  form.append('photo', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'product.jpg');
  const result = await telegram('sendPhoto', { method: 'POST', body: form });
  return { messageId: String(result.message_id), fileId: result.photo?.at(-1)?.file_id || null };
}
async function deleteTelegramMessage(messageId) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHANNEL_ID) return;
  try { await telegram('deleteMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHANNEL_ID, message_id: Number(messageId) }) }); } catch {}
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'EcomStore' }));

// Proxy Telegram images so the bot token and Telegram file paths stay server-side.
app.get('/api/images/:fileId', async (req, res) => {
  try {
    const fileId = String(req.params.fileId || '');
    if (!fileId || fileId.length > 2048) return fail(res, 400, 'Invalid image ID');
    const file = await telegram('getFile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: fileId })
    });
    if (!file.file_path) return fail(res, 404, 'Image not found');
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const imageResponse = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!imageResponse.ok) return fail(res, 502, 'Could not retrieve image');
    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return res.send(imageBuffer);
  } catch {
    return fail(res, 502, 'Image service unavailable');
  }
});

app.get('/api/products', async (req, res) => {
  if (!db(res)) return;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const q = String(req.query.q || '').trim().slice(0, 100);
  const category = String(req.query.category || '').trim().slice(0, 80);
  let query = supabase.from('products').select('id,title,description,price,stock,category,created_at,vendor_id,product_images(id,telegram_message_id,file_id,sort_order),vendors!inner(store_name,status)', { count: 'exact' })
    .eq('status', 'active').eq('vendors.status', 'approved').order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
  if (q) query = query.ilike('title', `%${q.replace(/[%_]/g, '')}%`);
  if (category) query = query.eq('category', category);
  const { data, error, count } = await query;
  if (error) return fail(res, 500, 'Could not load products');
  const products = (data || []).map(product => ({
    ...product,
    product_images: (product.product_images || []).map(image => ({
      ...image,
      image_url: image.file_id ? `/api/images/${encodeURIComponent(image.file_id)}` : null
    }))
  }));
  res.json({ data: products, page, limit, total: count || 0 });
});

app.post('/api/vendors/register', authenticate, async (req, res) => {
  if (!db(res)) return;
  const store_name = String(req.body.store_name || '').trim();
  const description = String(req.body.description || '').trim();
  if (store_name.length < 2 || store_name.length > 80) return fail(res, 400, 'Store name must be 2–80 characters');
  const { data: existing } = await vendorFor(req.user.id);
  if (existing) return fail(res, 409, 'Vendor application already exists');
  const { data, error } = await supabase.from('vendors').insert({ user_id: req.user.id, store_name, description }).select().single();
  if (error) return fail(res, 400, 'Could not submit vendor application');
  res.status(201).json({ data });
});

app.post('/api/products', authenticate, requireVendor, async (req, res) => {
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const category = String(req.body.category || 'General').trim();
  const price = Number(req.body.price);
  const stock = Number.parseInt(req.body.stock, 10);
  if (title.length < 2 || title.length > 160) return fail(res, 400, 'Invalid product title');
  if (!Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) return fail(res, 400, 'Invalid price or stock');
  const status = process.env.AUTO_APPROVE_PRODUCTS === 'true' ? 'active' : 'pending';
  const { data, error } = await supabase.from('products').insert({ vendor_id: req.vendor.id, title, description, category, price, stock, status }).select().single();
  if (error) return fail(res, 400, 'Could not create product');
  res.status(201).json({ data });
});

app.get('/api/vendor/products', authenticate, async (req, res) => {
  const { data: vendor } = await vendorFor(req.user.id);
  if (!vendor) return fail(res, 403, 'Vendor account not found');
  const { data, error } = await supabase.from('products').select('*,product_images(*)').eq('vendor_id', vendor.id).order('created_at', { ascending: false });
  if (error) return fail(res, 500, 'Could not load vendor products');
  res.json({ data });
});

app.patch('/api/products/:id', authenticate, requireVendor, async (req, res) => {
  const allowed = ['title', 'description', 'price', 'stock', 'category'];
  const patch = {};
  for (const key of allowed) if (req.body[key] !== undefined) patch[key] = req.body[key];
  if (!Object.keys(patch).length) return fail(res, 400, 'No valid fields supplied');
  if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.trim().length < 2 || patch.title.trim().length > 160)) return fail(res, 400, 'Invalid title');
  if (patch.price !== undefined && (!Number.isFinite(Number(patch.price)) || Number(patch.price) < 0)) return fail(res, 400, 'Invalid price');
  if (patch.stock !== undefined && (!Number.isInteger(Number(patch.stock)) || Number(patch.stock) < 0)) return fail(res, 400, 'Invalid stock');
  if (patch.title) patch.title = patch.title.trim();
  patch.status = process.env.AUTO_APPROVE_PRODUCTS === 'true' ? 'active' : 'pending';
  patch.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('products').update(patch).eq('id', req.params.id).eq('vendor_id', req.vendor.id).select().maybeSingle();
  if (error) return fail(res, 400, 'Could not update product');
  if (!data) return fail(res, 404, 'Product not found');
  res.json({ data });
});

app.delete('/api/products/:id', authenticate, async (req, res) => {
  const admin = await isAdmin(req.user.id);
  const { data: vendor } = await vendorFor(req.user.id);
  let query = supabase.from('products').select('id,vendor_id,product_images(id,telegram_message_id)').eq('id', req.params.id).maybeSingle();
  const { data: product, error: readError } = await query;
  if (readError || !product) return fail(res, 404, 'Product not found');
  if (!admin && (!vendor || product.vendor_id !== vendor.id)) return fail(res, 403, 'Not allowed');
  const { error } = await supabase.from('products').delete().eq('id', product.id);
  if (error) return fail(res, 500, 'Could not delete product');
  for (const img of product.product_images || []) await deleteTelegramMessage(img.telegram_message_id);
  res.json({ success: true });
});

app.post('/api/products/:id/images', authenticate, requireVendor, upload.array('images', 5), async (req, res) => {
  const { data: product } = await supabase.from('products').select('id').eq('id', req.params.id).eq('vendor_id', req.vendor.id).maybeSingle();
  if (!product) return fail(res, 404, 'Product not found');
  const { count } = await supabase.from('product_images').select('*', { count: 'exact', head: true }).eq('product_id', product.id);
  const files = req.files || [];
  if (!files.length) return fail(res, 400, 'Choose at least one image');
  if ((count || 0) + files.length > 5) return fail(res, 400, 'Maximum 5 images per product');
  const uploaded = [];
  try {
    for (const file of files) {
      if (!file.mimetype.startsWith('image/')) throw new Error('Only image files are allowed');
      const item = await uploadToTelegram(file);
      uploaded.push(item);
    }
    const rows = uploaded.map((item, index) => ({ product_id: product.id, telegram_message_id: item.messageId, file_id: item.fileId, sort_order: (count || 0) + index }));
    const { data, error } = await supabase.from('product_images').insert(rows).select();
    if (error) throw error;
    res.status(201).json({ data });
  } catch (error) {
    for (const item of uploaded) await deleteTelegramMessage(item.messageId);
    return fail(res, 502, error.message || 'Image upload failed');
  }
});

app.delete('/api/products/:id/images/:imageId', authenticate, requireVendor, async (req, res) => {
  const { data: product } = await supabase.from('products').select('id').eq('id', req.params.id).eq('vendor_id', req.vendor.id).maybeSingle();
  if (!product) return fail(res, 404, 'Product not found');
  const { data: imageRow } = await supabase.from('product_images').select('*').eq('id', req.params.imageId).eq('product_id', product.id).maybeSingle();
  if (!imageRow) return fail(res, 404, 'Image not found');
  const { error } = await supabase.from('product_images').delete().eq('id', imageRow.id);
  if (error) return fail(res, 500, 'Could not remove image');
  await deleteTelegramMessage(imageRow.telegram_message_id);
  res.json({ success: true });
});

app.get('/api/admin/vendors', authenticate, async (req, res) => {
  if (!await isAdmin(req.user.id)) return fail(res, 403, 'Admin only');
  const { data, error } = await supabase.from('vendors').select('*').order('created_at', { ascending: false });
  if (error) return fail(res, 500, 'Could not load vendors');
  res.json({ data });
});
app.patch('/api/admin/vendors/:id', authenticate, async (req, res) => {
  if (!await isAdmin(req.user.id)) return fail(res, 403, 'Admin only');
  const status = String(req.body.status || '');
  if (!['approved','rejected','blocked','pending'].includes(status)) return fail(res, 400, 'Invalid vendor status');
  const { data, error } = await supabase.from('vendors').update({ status }).eq('id', req.params.id).select().maybeSingle();
  if (error || !data) return fail(res, 400, 'Could not update vendor');
  res.json({ data });
});
app.patch('/api/admin/products/:id', authenticate, async (req, res) => {
  if (!await isAdmin(req.user.id)) return fail(res, 403, 'Admin only');
  const status = String(req.body.status || '');
  if (!['active','pending','rejected','archived'].includes(status)) return fail(res, 400, 'Invalid product status');
  const { data, error } = await supabase.from('products').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().maybeSingle();
  if (error || !data) return fail(res, 400, 'Could not update product');
  res.json({ data });
});

await nextApp.prepare();
app.use((req, res) => nextHandler(req, res));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return fail(res, 400, err.message);
  console.error('EcomStore request error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => console.log(`EcomStore full-stack service listening on ${port}`));
