'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Loader2, Search, Palette, Type, Play,
  Image as ImageIcon, Download, CheckCircle, FileArchive,
} from 'lucide-react';

type DesignData = {
  typography: string[];
  colors: {
    text: string[];
    background: string[];
  };
  animations: string[];
  images: string[];
  // raw data for ZIP download
  cssFiles: string[];
  inlineStyles: string[];
  fullHTML: string;
  pageUrl: string;
};

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<DesignData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadDone, setDownloadDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    setLoading(true);
    setError(null);
    setData(null);
    setDownloadDone(false);

    try {
      const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
      
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlObj.href }),
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.details || result.error || 'Failed to extract design data');
      }

      setData(result);
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!data) return;
    setDownloading(true);
    setDownloadDone(false);

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: data.pageUrl,
          cssFiles: data.cssFiles,
          inlineStyles: data.inlineStyles,
          fullHTML: data.fullHTML,
          images: data.images,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.details || err.error || 'Download failed');
      }

      const blob = await res.blob();
      const hostname = new URL(data.pageUrl).hostname.replace(/\./g, '-');
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `${hostname}-extract.zip`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      setDownloadDone(true);
    } catch (err: any) {
      setError(err.message || 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 selection:bg-indigo-500/30 font-sans">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-slate-950 to-slate-950 -z-10" />

      <main className="max-w-6xl mx-auto px-6 py-20 flex flex-col items-center">

        {/* Header Section */}
        <motion.div 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="text-center mb-12"
        >
          <div className="inline-block px-4 py-1.5 mb-6 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-sm font-medium tracking-wide">
            Design Extraction Tool
          </div>
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6 bg-clip-text text-transparent bg-gradient-to-br from-white via-slate-200 to-slate-500">
            Steal the Design.
          </h1>
          <p className="text-lg text-slate-400 max-w-2xl mx-auto">
            Extract stunning palettes, typography, and assets from any website instantly. Download a complete, editable ZIP to use as your own starting point.
          </p>
        </motion.div>

        {/* Input Form */}
        <motion.form 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          onSubmit={handleSubmit} 
          className="w-full max-w-2xl relative mb-16"
        >
          <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-2xl blur opacity-25 group-hover:opacity-40 transition duration-1000 group-hover:duration-200"></div>
            <div className="relative flex items-center bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
              <Search className="w-6 h-6 text-slate-400 ml-6" />
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://stripe.com"
                className="w-full bg-transparent px-6 py-5 text-lg outline-none placeholder:text-slate-500 text-white"
                required
              />
              <button
                type="submit"
                disabled={loading}
                className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-5 font-semibold transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Extract'}
              </button>
            </div>
          </div>
          {error && (
            <div className="absolute -bottom-8 left-0 right-0 text-center text-red-400 text-sm">
              {error}
            </div>
          )}
        </motion.form>

        {/* Results Dashboard */}
        <AnimatePresence>
          {data && (
            <motion.div
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full flex flex-col gap-6"
            >

              {/* Download ZIP Banner */}
              <motion.div
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.15 }}
                className="relative overflow-hidden rounded-3xl border border-indigo-500/30 bg-gradient-to-r from-indigo-950/80 to-purple-950/80 backdrop-blur-md shadow-2xl p-6"
              >
                {/* Glow strip */}
                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-500/60 to-transparent" />

                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-2xl bg-indigo-500/20 border border-indigo-500/30">
                      <FileArchive className="w-7 h-7 text-indigo-300" />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-white">Download as Editable ZIP</h2>
                      <p className="text-sm text-slate-400 mt-0.5">
                        {data.cssFiles.length} stylesheet{data.cssFiles.length !== 1 ? 's' : ''} &middot;&nbsp;
                        {data.images.length} image{data.images.length !== 1 ? 's' : ''} &middot;&nbsp;
                        Full HTML &middot; Fonts &middot; Ready to edit
                      </p>
                    </div>
                  </div>

                  <button
                    id="download-zip-btn"
                    onClick={handleDownload}
                    disabled={downloading}
                    className={`
                      relative flex items-center gap-2.5 px-6 py-3 rounded-xl font-semibold text-sm transition-all duration-200
                      ${downloadDone
                        ? 'bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 cursor-default'
                        : 'bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white border border-indigo-500 shadow-lg shadow-indigo-900/40'
                      }
                      disabled:opacity-60 disabled:cursor-not-allowed
                    `}
                  >
                    {downloading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Building ZIP…
                      </>
                    ) : downloadDone ? (
                      <>
                        <CheckCircle className="w-4 h-4" />
                        Downloaded!
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        Download ZIP
                      </>
                    )}
                  </button>
                </div>

                {/* Progress bar when downloading */}
                {downloading && (
                  <div className="mt-4 h-1 w-full rounded-full bg-slate-800 overflow-hidden">
                    <motion.div
                      className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full"
                      initial={{ width: '0%' }}
                      animate={{ width: '90%' }}
                      transition={{ duration: 12, ease: 'easeInOut' }}
                    />
                  </div>
                )}

                {/* What's inside chips */}
                <div className="flex flex-wrap gap-2 mt-4">
                  {[
                    { label: 'index.html', color: 'text-sky-300 bg-sky-900/30 border-sky-700/40' },
                    { label: 'styles.css', color: 'text-purple-300 bg-purple-900/30 border-purple-700/40' },
                    { label: 'assets/images/', color: 'text-emerald-300 bg-emerald-900/30 border-emerald-700/40' },
                    { label: 'assets/fonts/', color: 'text-amber-300 bg-amber-900/30 border-amber-700/40' },
                    { label: 'README.md', color: 'text-slate-300 bg-slate-800/50 border-slate-700/40' },
                  ].map(chip => (
                    <span
                      key={chip.label}
                      className={`text-xs font-mono px-2.5 py-1 rounded-md border ${chip.color}`}
                    >
                      {chip.label}
                    </span>
                  ))}
                </div>
              </motion.div>

              {/* Design Data Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                {/* Color Palette */}
                <DashboardCard title="Color Palette" icon={<Palette className="w-5 h-5 text-pink-400" />}>
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-sm font-medium text-slate-400 mb-3 uppercase tracking-wider">Backgrounds</h3>
                      <div className="flex flex-wrap gap-3">
                        {data.colors.background.map((c, i) => (
                          <ColorSwatch key={i} color={c} />
                        ))}
                      </div>
                    </div>
                    <div>
                      <h3 className="text-sm font-medium text-slate-400 mb-3 uppercase tracking-wider">Text Colors</h3>
                      <div className="flex flex-wrap gap-3">
                        {data.colors.text.map((c, i) => (
                          <ColorSwatch key={i} color={c} />
                        ))}
                      </div>
                    </div>
                  </div>
                </DashboardCard>

                {/* Typography */}
                <DashboardCard title="Typography" icon={<Type className="w-5 h-5 text-indigo-400" />}>
                  <div className="flex flex-col gap-4">
                    {data.typography.map((font, i) => (
                      <div key={i} className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/50 flex items-center justify-between">
                        <span className="font-mono text-sm text-slate-300" style={{ fontFamily: font }}>
                          {font.split(',')[0]}
                        </span>
                        <span className="text-2xl" style={{ fontFamily: font }}>Aa</span>
                      </div>
                    ))}
                    {data.typography.length === 0 && <span className="text-slate-500">No custom fonts detected.</span>}
                  </div>
                </DashboardCard>

                {/* Animations */}
                <DashboardCard title="Animations & Transitions" icon={<Play className="w-5 h-5 text-purple-400" />}>
                  <div className="flex flex-col gap-3">
                    {data.animations.map((anim, i) => (
                      <div key={i} className="px-4 py-3 rounded-lg bg-slate-800/30 border border-slate-700/30 font-mono text-xs text-slate-400 break-all">
                        {anim}
                      </div>
                    ))}
                    {data.animations.length === 0 && <span className="text-slate-500">No animations detected.</span>}
                  </div>
                </DashboardCard>

                {/* Assets Section */}
                <DashboardCard title="Discovered Assets" icon={<ImageIcon className="w-5 h-5 text-emerald-400" />}>
                  <div className="grid grid-cols-3 gap-4">
                    {data.images.map((src, i) => (
                       /* eslint-disable-next-line @next/next/no-img-element */
                      <img key={i} src={src} alt="" className="w-full aspect-square object-cover rounded-xl border border-slate-700/50" />
                    ))}
                    {data.images.length === 0 && <span className="text-slate-500 col-span-3">No images found.</span>}
                  </div>
                </DashboardCard>

              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

function DashboardCard({ title, icon, children }: { title: string, icon: React.ReactNode, children: React.ReactNode }) {
  return (
    <div className="p-6 rounded-3xl bg-slate-900/50 border border-slate-800 backdrop-blur-md shadow-xl flex flex-col h-full">
      <div className="flex items-center gap-3 mb-6 pb-4 border-b border-slate-800">
        <div className="p-2 rounded-lg bg-slate-800/80">
          {icon}
        </div>
        <h2 className="text-xl font-semibold">{title}</h2>
      </div>
      <div className="flex-1">
        {children}
      </div>
    </div>
  );
}

function ColorSwatch({ color }: { color: string }) {
  return (
    <div className="group relative flex items-center justify-center w-12 h-12 rounded-full border border-slate-700 shadow-sm hover:scale-110 transition-transform cursor-pointer" style={{ backgroundColor: color }}>
      <div className="absolute inset-x-0 -bottom-8 mx-auto opacity-0 group-hover:opacity-100 transition-opacity bg-slate-800 text-xs py-1 px-2 rounded whitespace-nowrap z-10 pointer-events-none">
        {color}
      </div>
    </div>
  );
}
