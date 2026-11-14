'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowserClient } from '../../lib/supabase';
import { ArrowLeft, Store, Package, ClipboardList, ShieldCheck, Plus, RefreshCw, LogOut, Check, X, Upload, Ban } from 'lucide-react';

type AnyRow = Record<string, any>;
type Tab = 'overview' | 'products' | 'orders' | 'vendors' | 'moderation';
export default function DashboardPage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('customer');
  const [vendor, setVendor] = useState<AnyRow | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<AnyRow[]>([]);
  const [overview, setOverview] = useState<AnyRow>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [storeName, setStoreName] = useState('');
  const [storeDescription, setStoreDescription] = useState('');
  const [productForm, setProductForm] = useState({ title:'', description:'', category:'General', price:'', stock:'1' });

  const api = useCallback(async (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (!(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Request failed');
    return result.data;
  }, [token]);

  const refresh = useCallback(async () => {
    if (!token) return;
    setBusy(true); setMessage('');
    try {
      const me = await api('/api/me');
      setRole(me.profile?.role || 'customer'); setVendor(me.vendor || null);
      if (me.isAdmin) {
        const [stats, vendors, products, orders] = await Promise.all([
          api('/api/admin/overview'), api('/api/admin/vendors'), api('/api/admin/products'), api('/api/admin/orders')
        ]);
        setOverview(stats); 
        if (tab === 'vendors') setData(vendors);
        else if (tab === 'moderation' || tab === 'products') setData(products);
        else if (tab === 'orders') setData(orders);
        else setData([]);
      } else if (me.vendor) {
        const [products, orders] = await Promise.all([api('/api/vendor/products'), api('/api/vendor/orders')]);
        if (tab === 'products') setData(products || []);
        else if (tab === 'orders') setData(orders || []);
        else setData([]);
      } else if (tab === 'orders') {
        setData(await api('/api/orders'));
      } else setData([]);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load dashboard'); }
    finally { setBusy(false); }
  }, [api, token, tab]);

  useEffect(() => {
    let active = true;
    const supabase = getSupabaseBrowserClient();
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      const session = data.session;
      if (!session) { router.replace('/'); return; }
      setToken(session.access_token); setEmail(session.user.email || '');
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) router.replace('/');
      else { setToken(session.access_token); setEmail(session.user.email || ''); }
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, [router]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function applyVendor(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMessage('');
    try { await api('/api/vendors/register', { method:'POST', body: JSON.stringify({ store_name:storeName, description:storeDescription }) }); setMessage('បានដាក់ពាក្យបើកហាងរួចរាល់។ រង់ចាំ Admin អនុម័ត។'); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Application failed'); }
    finally { setBusy(false); }
  }
  async function createProduct(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMessage('');
    try {
      const created = await api('/api/products', { method:'POST', body:JSON.stringify({ ...productForm, price:Number(productForm.price), stock:Number(productForm.stock) }) });
      const fileInput = document.getElementById('product-images') as HTMLInputElement | null;
      if (fileInput?.files?.length) {
        const form = new FormData(); Array.from(fileInput.files).slice(0,5).forEach(file => form.append('images', file));
        await api(`/api/products/${created.id}/images`, { method:'POST', body:form });
      }
      setProductForm({ title:'', description:'', category:'General', price:'', stock:'1' });
      if (fileInput) fileInput.value = '';
      setMessage('ផលិតផលបានបង្កើត។ វានឹងបង្ហាញក្រោយ Admin អនុម័ត។'); await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not create product'); }
    finally { setBusy(false); }
  }
  async function update(path: string, body: AnyRow) {
    setBusy(true); setMessage('');
    try { await api(path, { method:'PATCH', body:JSON.stringify(body) }); setMessage('បានរក្សាទុកការផ្លាស់ប្ដូរ។'); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Update failed'); }
    finally { setBusy(false); }
  }
  async function removeProduct(id: string) {
    if (!confirm('លុបផលិតផលនេះមែនទេ?')) return;
    setBusy(true); try { await api(`/api/products/${id}`, { method:'DELETE' }); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Delete failed'); } finally { setBusy(false); }
  }
  async function signOut() { await getSupabaseBrowserClient().auth.signOut(); router.replace('/'); }

  const tabs: {id:Tab;label:string;icon:any}[] = [
    {id:'overview',label:'Overview',icon:ClipboardList},{id:'products',label:'Products',icon:Package},{id:'orders',label:'Orders',icon:Store},
    ...(role === 'admin' ? [{id:'vendors' as Tab,label:'Vendors',icon:Store},{id:'moderation' as Tab,label:'Moderation',icon:ShieldCheck}] : [])
  ];
  return <main className="min-h-screen bg-slate-50 text-slate-900">
    <header className="sticky top-0 z-20 border-b bg-white"><div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4"><div className="flex items-center gap-3"><Link href="/" className="rounded-xl border p-2"><ArrowLeft size={18}/></Link><div><h1 className="text-xl font-black">EcomStore Dashboard</h1><p className="text-xs text-slate-500">{email} · {role}</p></div></div><div className="flex gap-2"><button onClick={() => void refresh()} className="rounded-xl border p-2"><RefreshCw size={18}/></button><button onClick={() => void signOut()} className="rounded-xl border p-2"><LogOut size={18}/></button></div></div></header>
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-7 md:grid-cols-[220px_1fr]">
      <aside className="h-fit rounded-2xl border bg-white p-3">{tabs.map(item => { const Icon = item.icon; return <button key={item.id} onClick={() => setTab(item.id)} className={`mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold ${tab===item.id?'bg-amber-50 text-amber-700':'text-slate-600 hover:bg-slate-50'}`}><Icon size={18}/>{item.label}</button>; })}</aside>
      <section className="min-w-0">
        {message && <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{message}</div>}
        {busy && <p className="mb-3 text-sm text-slate-500">Processing…</p>}
        {tab==='overview' && <><h2 className="mb-5 text-2xl font-black">Overview</h2>{role==='admin' ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[['Vendors',overview.vendors],['Pending vendors',overview.pendingVendors],['Products',overview.products],['Pending products',overview.pendingProducts],['Orders',overview.orders],['Customers',overview.customers],['Revenue',`$${Number(overview.revenue||0).toFixed(2)}`]].map(([label,value])=><div key={String(label)} className="rounded-2xl border bg-white p-5"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-3xl font-black">{value ?? '—'}</p></div>)}</div> : <div className="rounded-2xl border bg-white p-6"><h3 className="text-lg font-bold">Welcome to your account</h3><p className="mt-2 text-sm text-slate-600">{vendor ? `Store: ${vendor.store_name} · Status: ${vendor.status}` : 'You can shop products or apply to become a seller.'}</p><div className="mt-5 flex flex-wrap gap-3"><button onClick={()=>setTab('orders')} className="rounded-xl bg-slate-900 px-4 py-2 text-white">My orders</button>{vendor && <button onClick={()=>setTab('products')} className="rounded-xl border px-4 py-2">Manage products</button>}</div></div>}</>}
        {tab==='overview' && role!=='admin' && !vendor && <form onSubmit={applyVendor} className="mt-5 max-w-xl rounded-2xl border bg-white p-6"><h3 className="text-lg font-black">Open your store</h3><p className="mb-4 text-sm text-slate-500">Submit your seller application for admin review.</p><input required minLength={2} value={storeName} onChange={e=>setStoreName(e.target.value)} placeholder="Store name" className="mb-3 w-full rounded-xl border px-4 py-3"/><textarea value={storeDescription} onChange={e=>setStoreDescription(e.target.value)} placeholder="Describe your store" className="mb-3 min-h-24 w-full rounded-xl border px-4 py-3"/><button disabled={busy} className="rounded-xl bg-amber-500 px-5 py-3 font-bold text-white">Apply to sell</button></form>}
        {tab==='overview' && vendor?.status==='pending' && <div className="mt-5 rounded-2xl border bg-white p-6"><p className="font-bold">Seller application pending</p><p className="mt-1 text-sm text-slate-500">Admin will review your store before product listing is enabled.</p></div>}
        {tab==='products' && <><div className="mb-5 flex items-center justify-between"><h2 className="text-2xl font-black">{role==='admin'?'All products':'My products'}</h2></div>
          {role!=='admin' && vendor?.status==='approved' && <form onSubmit={createProduct} className="mb-6 grid gap-3 rounded-2xl border bg-white p-5 md:grid-cols-2"><h3 className="md:col-span-2 text-lg font-bold">Add a product</h3><input required minLength={2} placeholder="Product title" value={productForm.title} onChange={e=>setProductForm({...productForm,title:e.target.value})} className="rounded-xl border px-3 py-3"/><input required placeholder="Category" value={productForm.category} onChange={e=>setProductForm({...productForm,category:e.target.value})} className="rounded-xl border px-3 py-3"/><textarea placeholder="Description" value={productForm.description} onChange={e=>setProductForm({...productForm,description:e.target.value})} className="rounded-xl border px-3 py-3 md:col-span-2"/><input required type="number" min="0" step="0.01" placeholder="Price USD" value={productForm.price} onChange={e=>setProductForm({...productForm,price:e.target.value})} className="rounded-xl border px-3 py-3"/><input required type="number" min="0" step="1" placeholder="Stock" value={productForm.stock} onChange={e=>setProductForm({...productForm,stock:e.target.value})} className="rounded-xl border px-3 py-3"/><label className="text-sm text-slate-600 md:col-span-2">Product images (up to 5, sent to Telegram)<input id="product-images" type="file" accept="image/*" multiple className="mt-2 block w-full text-sm"/></label><button disabled={busy} className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 font-bold text-white md:col-span-2"><Plus size={18}/>Create product</button></form>}
          {role!=='admin' && !vendor && <p className="rounded-xl border bg-white p-5 text-sm text-slate-600">Apply to become a vendor from Overview before adding products.</p>}
          <div className="space-y-3">{data.map(row=><div key={row.id} className="flex flex-col gap-3 rounded-2xl border bg-white p-4 sm:flex-row sm:items-center"><div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-100">{row.product_images?.[0]?.image_url?<img src={row.product_images[0].image_url} className="h-full w-full object-cover" alt=""/>:<Package className="text-slate-400"/>}</div><div className="min-w-0 flex-1"><p className="font-bold">{row.title}</p><p className="text-sm text-slate-500">${Number(row.price).toFixed(2)} · Stock {row.stock} · {row.category}</p><p className="text-xs text-slate-500">Status: {row.status} {row.vendors?.store_name? '· '+row.vendors.store_name:''}</p></div>{role==='admin'?<div className="flex flex-wrap gap-2"><button onClick={()=>void update(`/api/admin/products/${row.id}`,{status:'active'})} className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">Approve</button><button onClick={()=>void update(`/api/admin/products/${row.id}`,{status:'rejected'})} className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700">Reject</button></div>:<div className="flex gap-2"><button onClick={()=>{const stock=prompt('New stock quantity',String(row.stock));if(stock!==null)void update(`/api/products/${row.id}`,{stock:Number(stock)});}} className="rounded-lg border px-3 py-2 text-xs">Edit stock</button><button onClick={()=>void removeProduct(row.id)} className="rounded-lg border px-3 py-2 text-xs text-red-600">Delete</button></div>}</div>)}</div>
        </>}
        {tab==='vendors' && role==='admin' && <><h2 className="mb-5 text-2xl font-black">Vendor applications</h2><div className="space-y-3">{data.map(row=><div key={row.id} className="flex flex-col gap-3 rounded-2xl border bg-white p-5 sm:flex-row sm:items-center"><div className="flex-1"><p className="font-bold">{row.store_name}</p><p className="text-sm text-slate-500">{row.profiles?.display_name} · {row.profiles?.phone||'No phone'}</p><p className="text-xs text-slate-500">{row.description}</p><p className="mt-1 text-xs font-semibold">Status: {row.status}</p></div><div className="flex flex-wrap gap-2"><button onClick={()=>void update(`/api/admin/vendors/${row.id}`,{status:'approved'})} className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700"><Check size={14} className="inline"/> Approve</button><button onClick={()=>void update(`/api/admin/vendors/${row.id}`,{status:'rejected'})} className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700"><X size={14} className="inline"/> Reject</button><button onClick={()=>void update(`/api/admin/vendors/${row.id}`,{status:'blocked'})} className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold"><Ban size={14} className="inline"/> Block</button></div></div>)}</div></>}
        {tab==='moderation' && role==='admin' && <><h2 className="mb-5 text-2xl font-black">Product moderation</h2><div className="space-y-3">{data.filter(row=>row.status==='pending').map(row=><div key={row.id} className="flex flex-col gap-3 rounded-2xl border bg-white p-5 sm:flex-row sm:items-center"><div className="flex-1"><p className="font-bold">{row.title}</p><p className="text-sm text-slate-500">{row.vendors?.store_name} · ${Number(row.price).toFixed(2)} · Stock {row.stock}</p><p className="text-sm text-slate-500">{row.description}</p></div><div className="flex gap-2"><button onClick={()=>void update(`/api/admin/products/${row.id}`,{status:'active'})} className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">Approve</button><button onClick={()=>void update(`/api/admin/products/${row.id}`,{status:'rejected'})} className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700">Reject</button></div></div>)}{data.every(row=>row.status!=='pending')&&<p className="rounded-xl border bg-white p-5 text-sm text-slate-500">No products waiting for review.</p>}</div></>}
        {tab==='orders' && <><h2 className="mb-5 text-2xl font-black">{role==='admin'?'All orders':vendor?'Store orders':'My orders'}</h2><div className="space-y-3">{data.map((row,index)=>{const order=row.orders||row;const isVendorItem=Boolean(row.orders);return <div key={row.id||index} className="rounded-2xl border bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-bold">Order #{String(order.id).slice(0,8)}</p><p className="text-xs text-slate-500">{new Date(order.created_at).toLocaleString()}</p></div><span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-800">{order.status}</span></div><p className="mt-3 text-sm">Total: <b>${Number(order.total).toFixed(2)}</b> · Payment: {order.payment_method} / {order.payment_status}</p>{order.customer_name&&<p className="mt-1 text-sm text-slate-600">{order.customer_name} · {order.customer_phone}</p>}{order.delivery_address&&<p className="mt-1 text-sm text-slate-600">Delivery: {order.delivery_address}</p>}{isVendorItem&&<p className="mt-1 text-sm text-slate-600">{row.products?.title} × {row.quantity}</p>}{order.order_items?.map((item:AnyRow,i:number)=><p key={i} className="mt-1 text-sm text-slate-600">{item.products?.title||'Item'} × {item.quantity} · ${Number(item.unit_price).toFixed(2)}</p>)}{role==='admin'&&<div className="mt-3 flex flex-wrap gap-2"><button onClick={()=>void update(`/api/admin/orders/${order.id}`,{status:'processing'})} className="rounded-lg border px-3 py-2 text-xs">Processing</button><button onClick={()=>void update(`/api/admin/orders/${order.id}`,{status:'shipped'})} className="rounded-lg border px-3 py-2 text-xs">Shipped</button><button onClick={()=>void update(`/api/admin/orders/${order.id}`,{status:'completed',payment_status:'paid'})} className="rounded-lg border px-3 py-2 text-xs">Complete / Paid</button></div>}{role!=='admin'&&vendor&&<div className="mt-3 flex flex-wrap gap-2"><button onClick={()=>void update(`/api/vendor/orders/${order.id}`,{status:'processing'})} className="rounded-lg border px-3 py-2 text-xs">Accept / Processing</button><button onClick={()=>void update(`/api/vendor/orders/${order.id}`,{status:'shipped'})} className="rounded-lg border px-3 py-2 text-xs">Mark shipped</button></div>}</div>})}{!data.length&&<p className="rounded-xl border bg-white p-5 text-sm text-slate-500">No orders found.</p>}</div></>}
      </section>
    </div>
  </main>;
}
