'use client';

import { useEffect, useState } from 'react';
import { Search, ShoppingBag, Store, ShieldCheck, ArrowRight } from 'lucide-react';

type Product = { id: string; title: string; description: string; price: number; category: string; vendors?: { store_name: string }; product_images?: { id: string }[] };
const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:10000';

export default function Home() {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  async function loadProducts(search = '') {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ page: '1', limit: '24' });
      if (search.trim()) params.set('q', search.trim());
      const response = await fetch(`${API}/api/products?${params}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Unable to load products');
      const result = await response.json();
      setProducts(result.data || []);
    } catch { setError('Marketplace API is not connected yet. Configure Render and Supabase to show live products.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadProducts(); }, []);
  return <main>
    <header className="border-b border-[var(--line)] bg-white">
      <div className="container flex h-20 items-center justify-between gap-5">
        <a href="/" className="flex items-center gap-2 text-2xl font-black tracking-tight"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--gold)] text-white">E</span>EcomStore</a>
        <nav className="hidden items-center gap-7 text-sm font-semibold text-[var(--muted)] md:flex"><a href="#discover">Discover</a><a href="#sell">Sell on EcomStore</a><a href="#trust">Why EcomStore</a></nav>
        <a href="#sell" className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-bold text-white">Start selling</a>
      </div>
    </header>
    <section className="bg-white">
      <div className="container grid gap-10 py-16 md:grid-cols-[1.1fr_.9fr] md:items-center md:py-24">
        <div><p className="mb-4 text-sm font-bold uppercase tracking-[.18em] text-amber-600">One marketplace. Many possibilities.</p>
          <h1 className="max-w-2xl text-5xl font-black leading-[1.08] tracking-tight md:text-6xl">Everything you need, <span className="text-amber-500">all in one place.</span></h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-[var(--muted)]">Explore products from independent stores and discover something you love.</p>
          <form className="mt-8 flex max-w-xl gap-2 rounded-2xl border border-[var(--line)] bg-white p-2 shadow-lg shadow-slate-200/60" onSubmit={e => { e.preventDefault(); void loadProducts(query); }}>
            <Search className="ml-3 mt-2.5 text-slate-400" size={20}/><input aria-label="Search products" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search products..." className="min-w-0 flex-1 bg-transparent px-2 py-2 outline-none"/><button className="rounded-xl bg-amber-500 px-5 font-bold text-white">Search</button>
          </form>
          <div className="mt-5 flex flex-wrap gap-5 text-sm text-[var(--muted)]"><span className="flex items-center gap-2"><ShieldCheck size={17}/> Trusted stores</span><span className="flex items-center gap-2"><ShoppingBag size={17}/> Wide selection</span></div>
        </div>
        <div className="rounded-[2rem] bg-gradient-to-br from-amber-100 via-orange-50 to-slate-100 p-8 md:p-12"><div className="rounded-3xl bg-white/80 p-8 shadow-xl"><div className="mb-8 flex items-center justify-between"><span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-700">MARKETPLACE</span><ShoppingBag size={28} className="text-amber-500"/></div><div className="grid grid-cols-2 gap-4"><div className="h-28 rounded-2xl bg-gradient-to-br from-amber-200 to-orange-100"/><div className="h-28 rounded-2xl bg-gradient-to-br from-sky-100 to-blue-200"/><div className="h-28 rounded-2xl bg-gradient-to-br from-rose-100 to-pink-200"/><div className="h-28 rounded-2xl bg-gradient-to-br from-emerald-100 to-green-200"/></div><p className="mt-6 text-center font-bold">Find your next favorite thing</p></div></div>
      </div>
    </section>
    <section id="discover" className="container py-16"><div className="mb-8 flex items-end justify-between"><div><p className="text-sm font-bold uppercase tracking-widest text-amber-600">Explore</p><h2 className="mt-2 text-3xl font-black">Featured products</h2></div><span className="text-sm text-[var(--muted)]">{products.length} products</span></div>
      {loading ? <p className="py-12 text-center text-[var(--muted)]">Loading products…</p> : error ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-[var(--muted)]">{error}</div> : products.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-[var(--muted)]">No products yet. Approved vendor products will appear here.</div> :
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{products.map(p => <article key={p.id} className="overflow-hidden rounded-2xl border border-[var(--line)] bg-white"><div className="grid h-48 place-items-center bg-slate-100 text-slate-300"><ShoppingBag size={42}/></div><div className="p-4"><p className="text-xs font-semibold text-amber-600">{p.category}</p><h3 className="mt-2 font-bold">{p.title}</h3><p className="mt-1 line-clamp-2 text-sm text-[var(--muted)]">{p.description}</p><p className="mt-4 text-lg font-black">${Number(p.price).toFixed(2)}</p><p className="mt-1 text-xs text-[var(--muted)]">{p.vendors?.store_name || 'Marketplace seller'}</p></div></article>)}</div>}
    </section>
    <section id="sell" className="bg-slate-900 py-16 text-white"><div className="container flex flex-col items-start justify-between gap-6 md:flex-row md:items-center"><div><p className="text-sm font-bold uppercase tracking-widest text-amber-400">For businesses</p><h2 className="mt-2 text-3xl font-black">Bring your store online.</h2><p className="mt-3 max-w-xl text-slate-300">Join the marketplace and reach more customers.</p></div><a href="mailto:support@ecomstore.example" className="flex items-center gap-2 rounded-xl bg-amber-500 px-5 py-3 font-bold text-white">Become a vendor <ArrowRight size={18}/></a></div></section>
    <footer id="trust" className="container flex flex-col justify-between gap-3 py-8 text-sm text-[var(--muted)] md:flex-row"><span>© {new Date().getFullYear()} EcomStore</span><span className="flex items-center gap-2"><Store size={16}/> Built for local and global sellers</span></footer>
  </main>;
}
