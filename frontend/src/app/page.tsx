'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Search, ShoppingBag, Store, ShieldCheck, ArrowRight, UserRound, X, Plus, Minus, Trash2, LogOut, Package } from 'lucide-react';
import { getSupabaseBrowserClient } from '../lib/supabase';

type Product = { id: string; title: string; description: string; price: number; stock: number; category: string; vendors?: { store_name: string }; product_images?: { id: string; image_url?: string | null }[] };
type CartItem = { product: Product; quantity: number };

export default function Home() {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [cartOpen, setCartOpen] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const cartTotal = useMemo(() => cart.reduce((sum, item) => sum + Number(item.product.price) * item.quantity, 0), [cart]);

  async function loadProducts(search = '') {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ page: '1', limit: '24' });
      if (search.trim()) params.set('q', search.trim());
      const response = await fetch(`/api/products?${params}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load products');
      const result = await response.json();
      setProducts(result.data || []);
    } catch { setError('មិនអាចទាញយកផលិតផលបានទេ។ សូមពិនិត្យ API និង Supabase។'); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    void loadProducts();
    try { const saved = localStorage.getItem('ecomstore-cart-v1'); if (saved) setCart(JSON.parse(saved)); } catch {}
    try {
      const supabase = getSupabaseBrowserClient();
      void supabase.auth.getSession().then(({ data }) => setUserEmail(data.session?.user.email || ''));
      const { data } = supabase.auth.onAuthStateChange((_event, session) => setUserEmail(session?.user.email || ''));
      return () => data.subscription.unsubscribe();
    } catch { setAuthMessage('Supabase មិនទាន់បានកំណត់នៅក្នុង Render ទេ។'); }
  }, []);

  useEffect(() => { localStorage.setItem('ecomstore-cart-v1', JSON.stringify(cart)); }, [cart]);

  function addToCart(product: Product) {
    setCart(current => {
      const old = current.find(item => item.product.id === product.id);
      if (old) return current.map(item => item.product.id === product.id ? { ...item, quantity: Math.min(item.quantity + 1, Math.max(product.stock, 1)) } : item);
      return [...current, { product, quantity: 1 }];
    });
    setSelectedProduct(null); setCartOpen(true);
  }
  function changeQty(id: string, amount: number) {
    setCart(current => current.map(item => item.product.id === id ? { ...item, quantity: item.quantity + amount } : item).filter(item => item.quantity > 0));
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthBusy(true); setAuthMessage('');
    try {
      const supabase = getSupabaseBrowserClient();
      if (authMode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName.trim() } } });
        if (error) throw error;
        setAuthMessage(data.session ? 'គណនីបានបង្កើតរួចរាល់។' : 'បានចុះឈ្មោះ។ សូមពិនិត្យអ៊ីមែលដើម្បីបញ្ជាក់គណនី។');
        if (data.session) setAuthOpen(false);
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setAuthOpen(false); setPassword('');
      }
    } catch (err) { setAuthMessage(err instanceof Error ? err.message : 'Authentication failed.'); }
    finally { setAuthBusy(false); }
  }
  async function signOut() {
    try { const { error } = await getSupabaseBrowserClient().auth.signOut(); if (error) throw error; }
    catch (err) { setAuthMessage(err instanceof Error ? err.message : 'Sign out failed.'); }
  }

  return <main>
    <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-white/95 backdrop-blur">
      <div className="container flex min-h-20 items-center justify-between gap-3">
        <a href="/" className="flex shrink-0 items-center gap-2 text-xl font-black sm:text-2xl"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--gold)] text-white">E</span>EcomStore</a>
        <nav className="hidden items-center gap-7 text-sm font-semibold text-[var(--muted)] md:flex"><a href="#discover">Discover</a><a href="#sell">Sell on EcomStore</a><a href="#trust">Why EcomStore</a></nav>
        <div className="flex items-center gap-2">
          <button onClick={() => setCartOpen(true)} className="relative grid h-10 w-10 place-items-center rounded-xl border border-[var(--line)]"><ShoppingBag size={19}/>{cartCount > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-amber-500 px-1.5 text-xs font-bold text-white">{cartCount}</span>}</button>
          {userEmail ? <><span className="hidden max-w-32 truncate text-xs sm:block">{userEmail}</span><button onClick={() => void signOut()} title="Sign out" className="grid h-10 w-10 place-items-center rounded-xl border"><LogOut size={17}/></button></> : <button onClick={() => { setAuthMode('signin'); setAuthOpen(true); }} className="flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-bold text-white"><UserRound size={16}/>Sign in</button>}
        </div>
      </div>
    </header>
    <section className="bg-white"><div className="container grid gap-10 py-14 md:grid-cols-[1.1fr_.9fr] md:items-center md:py-24">
      <div><p className="mb-4 text-sm font-bold uppercase tracking-[.18em] text-amber-600">One marketplace. Many possibilities.</p><h1 className="max-w-2xl text-5xl font-black leading-[1.08] md:text-6xl">Everything you need, <span className="text-amber-500">all in one place.</span></h1><p className="mt-6 max-w-xl text-lg leading-8 text-[var(--muted)]">Explore products from independent stores and discover something you love.</p>
        <form className="mt-8 flex max-w-xl gap-2 rounded-2xl border border-[var(--line)] bg-white p-2 shadow-lg" onSubmit={e => { e.preventDefault(); void loadProducts(query); }}><Search className="ml-3 mt-2.5 text-slate-400" size={20}/><input aria-label="Search products" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search products..." className="min-w-0 flex-1 bg-transparent px-2 py-2 outline-none"/><button className="rounded-xl bg-amber-500 px-5 font-bold text-white">Search</button></form>
        <div className="mt-5 flex gap-5 text-sm text-[var(--muted)]"><span className="flex items-center gap-2"><ShieldCheck size={17}/>Trusted stores</span><span className="flex items-center gap-2"><ShoppingBag size={17}/>Wide selection</span></div>
      </div>
      <div className="rounded-[2rem] bg-gradient-to-br from-amber-100 via-orange-50 to-slate-100 p-8 md:p-12"><div className="rounded-3xl bg-white/80 p-8 shadow-xl"><div className="mb-8 flex justify-between"><span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-700">MARKETPLACE</span><ShoppingBag size={28} className="text-amber-500"/></div><div className="grid grid-cols-2 gap-4"><div className="h-28 rounded-2xl bg-gradient-to-br from-amber-200 to-orange-100"/><div className="h-28 rounded-2xl bg-gradient-to-br from-sky-100 to-blue-200"/><div className="h-28 rounded-2xl bg-gradient-to-br from-rose-100 to-pink-200"/><div className="h-28 rounded-2xl bg-gradient-to-br from-emerald-100 to-green-200"/></div><p className="mt-6 text-center font-bold">Find your next favorite thing</p></div></div>
    </div></section>
    <section id="discover" className="container py-16"><div className="mb-8 flex items-end justify-between"><div><p className="text-sm font-bold uppercase tracking-widest text-amber-600">Explore</p><h2 className="mt-2 text-3xl font-black">Featured products</h2></div><span className="text-sm text-[var(--muted)]">{products.length} products</span></div>
      {loading ? <p className="py-12 text-center text-[var(--muted)]">Loading products…</p> : error ? <div className="rounded-2xl border border-dashed bg-white p-10 text-center text-[var(--muted)]">{error}</div> : products.length === 0 ? <div className="rounded-2xl border border-dashed bg-white p-10 text-center text-[var(--muted)]">No products yet. Approved vendor products will appear here.</div> :
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{products.map(p => <article key={p.id} className="group overflow-hidden rounded-2xl border border-[var(--line)] bg-white transition hover:-translate-y-1 hover:shadow-lg"><button onClick={() => setSelectedProduct(p)} className="block w-full text-left"><div className="grid h-48 place-items-center overflow-hidden bg-slate-100 text-slate-300">{p.product_images?.[0]?.image_url ? <img src={p.product_images[0].image_url} alt={p.title} className="h-full w-full object-cover" loading="lazy"/> : <Package size={42}/>}</div><div className="p-4"><p className="text-xs font-semibold text-amber-600">{p.category}</p><h3 className="mt-2 font-bold">{p.title}</h3><p className="mt-1 line-clamp-2 text-sm text-[var(--muted)]">{p.description}</p><p className="mt-4 text-lg font-black">${Number(p.price).toFixed(2)}</p><p className="mt-1 text-xs text-[var(--muted)]">{p.vendors?.store_name || 'Marketplace seller'}</p></div></button><div className="px-4 pb-4"><button onClick={() => addToCart(p)} disabled={p.stock <= 0} className="w-full rounded-xl bg-slate-900 py-2.5 text-sm font-bold text-white hover:bg-amber-500 disabled:bg-slate-300">{p.stock > 0 ? 'Add to cart' : 'Out of stock'}</button></div></article>)}</div>}
    </section>
    <section id="sell" className="bg-slate-900 py-16 text-white"><div className="container flex flex-col items-start justify-between gap-6 md:flex-row md:items-center"><div><p className="text-sm font-bold uppercase tracking-widest text-amber-400">For businesses</p><h2 className="mt-2 text-3xl font-black">Bring your store online.</h2><p className="mt-3 max-w-xl text-slate-300">Join the marketplace and reach more customers.</p></div><button onClick={() => { setAuthMode('signup'); setAuthOpen(true); }} className="flex items-center gap-2 rounded-xl bg-amber-500 px-5 py-3 font-bold text-white">Become a vendor <ArrowRight size={18}/></button></div></section>
    <footer id="trust" className="container flex flex-col justify-between gap-3 py-8 text-sm text-[var(--muted)] md:flex-row"><span>© {new Date().getFullYear()} EcomStore</span><span className="flex items-center gap-2"><Store size={16}/>Built for local and global sellers</span></footer>

    {authOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-4" onMouseDown={e => { if (e.target === e.currentTarget) setAuthOpen(false); }}><section className="w-full max-w-md rounded-3xl bg-white p-7 shadow-2xl"><div className="mb-6 flex items-center justify-between"><div><p className="text-sm font-bold text-amber-600">ECOMSTORE ACCOUNT</p><h2 className="mt-1 text-2xl font-black">{authMode === 'signin' ? 'Welcome back' : 'Create your account'}</h2></div><button onClick={() => setAuthOpen(false)} className="rounded-full p-2 hover:bg-slate-100"><X/></button></div><div className="mb-5 grid grid-cols-2 rounded-xl bg-slate-100 p-1"><button onClick={() => { setAuthMode('signin'); setAuthMessage(''); }} className={`rounded-lg py-2 text-sm font-bold ${authMode === 'signin' ? 'bg-white shadow' : 'text-slate-500'}`}>Sign in</button><button onClick={() => { setAuthMode('signup'); setAuthMessage(''); }} className={`rounded-lg py-2 text-sm font-bold ${authMode === 'signup' ? 'bg-white shadow' : 'text-slate-500'}`}>Register</button></div><form onSubmit={submitAuth} className="space-y-4">{authMode === 'signup' && <label className="block text-sm font-semibold">Full name<input required minLength={2} value={displayName} onChange={e => setDisplayName(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-3 font-normal" placeholder="Your name"/></label>}<label className="block text-sm font-semibold">Email<input required type="email" value={email} onChange={e => setEmail(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-3 font-normal" placeholder="you@example.com"/></label><label className="block text-sm font-semibold">Password<input required type="password" minLength={6} value={password} onChange={e => setPassword(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-3 font-normal" placeholder="At least 6 characters"/></label><button disabled={authBusy} className="w-full rounded-xl bg-slate-900 py-3.5 font-bold text-white disabled:opacity-50">{authBusy ? 'Please wait…' : authMode === 'signin' ? 'Sign in' : 'Create account'}</button></form>{authMessage && <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{authMessage}</p>}</section></div>}

    {cartOpen && <div className="fixed inset-0 z-50 bg-slate-950/40" onMouseDown={e => { if (e.target === e.currentTarget) setCartOpen(false); }}><aside className="ml-auto flex h-full w-full max-w-md flex-col bg-white shadow-2xl"><div className="flex items-center justify-between border-b p-5"><div><h2 className="text-xl font-black">Your cart</h2><p className="text-sm text-[var(--muted)]">{cartCount} items</p></div><button onClick={() => setCartOpen(false)} className="rounded-full p-2 hover:bg-slate-100"><X/></button></div><div className="flex-1 space-y-4 overflow-y-auto p-5">{cart.length === 0 ? <div className="grid h-full place-items-center text-[var(--muted)]">Your cart is empty.</div> : cart.map(item => <div key={item.product.id} className="flex gap-3 border-b pb-4"><div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-100">{item.product.product_images?.[0]?.image_url ? <img src={item.product.product_images[0].image_url} alt="" className="h-full w-full object-cover"/> : <Package/>}</div><div className="min-w-0 flex-1"><p className="truncate font-bold">{item.product.title}</p><p className="mt-1 font-black text-amber-600">${Number(item.product.price).toFixed(2)}</p><div className="mt-2 flex items-center gap-3"><button onClick={() => changeQty(item.product.id, -1)} className="rounded-lg border p-1"><Minus size={14}/></button><span className="text-sm font-bold">{item.quantity}</span><button onClick={() => changeQty(item.product.id, 1)} disabled={item.quantity >= item.product.stock} className="rounded-lg border p-1 disabled:opacity-40"><Plus size={14}/></button><button onClick={() => setCart(current => current.filter(row => row.product.id !== item.product.id))} className="ml-auto text-slate-400 hover:text-red-500"><Trash2 size={16}/></button></div></div></div>)}</div><div className="border-t p-5"><div className="mb-4 flex justify-between text-lg font-black"><span>Subtotal</span><span>${cartTotal.toFixed(2)}</span></div><button disabled={cart.length === 0} onClick={() => { setCartOpen(false); setAuthMode('signin'); setAuthOpen(true); setAuthMessage('Checkout នឹងត្រូវបានភ្ជាប់នៅដំណាក់កាលបន្ទាប់។'); }} className="w-full rounded-xl bg-amber-500 py-3.5 font-bold text-white disabled:bg-slate-300">Continue to checkout</button><p className="mt-3 text-center text-xs text-slate-500">Cart is saved on this device.</p></div></aside></div>}

    {selectedProduct && <div className="fixed inset-0 z-40 grid place-items-center bg-slate-950/50 p-4" onMouseDown={e => { if (e.target === e.currentTarget) setSelectedProduct(null); }}><section className="relative grid max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white md:grid-cols-2"><button onClick={() => setSelectedProduct(null)} className="absolute right-3 top-3 rounded-full bg-white p-2 shadow"><X/></button><div className="grid min-h-64 place-items-center bg-slate-100">{selectedProduct.product_images?.[0]?.image_url ? <img src={selectedProduct.product_images[0].image_url} alt={selectedProduct.title} className="h-full max-h-96 w-full object-cover"/> : <Package size={60} className="text-slate-300"/>}</div><div className="p-7 md:p-9"><p className="text-xs font-bold uppercase tracking-widest text-amber-600">{selectedProduct.category}</p><h2 className="mt-3 text-2xl font-black">{selectedProduct.title}</h2><p className="mt-3 text-sm leading-6 text-[var(--muted)]">{selectedProduct.description || 'No description available.'}</p><p className="mt-6 text-3xl font-black">${Number(selectedProduct.price).toFixed(2)}</p><p className="mt-2 text-sm text-[var(--muted)]">Sold by {selectedProduct.vendors?.store_name || 'Marketplace seller'}</p><p className="mt-1 text-sm text-[var(--muted)]">{selectedProduct.stock} in stock</p><button onClick={() => addToCart(selectedProduct)} disabled={selectedProduct.stock <= 0} className="mt-7 w-full rounded-xl bg-slate-900 py-3 font-bold text-white hover:bg-amber-500 disabled:bg-slate-300">Add to cart</button></div></section></div>}
  </main>;
}
