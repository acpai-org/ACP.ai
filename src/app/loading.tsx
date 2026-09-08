// Route loading boundary. Kept server-only & zero-dependency so it paints
// immediately while the heavy Chat route and its client chunks compile.
// Do NOT import client modules here — they would block this file's render.
export default function Loading() {
  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-[var(--page-bg)] overflow-hidden">
      <div className="pointer-events-none absolute -right-32 top-1/4 h-72 w-72 rounded-full bg-cyan-400/20 blur-[120px]" />
      <div className="pointer-events-none absolute -left-32 bottom-1/4 h-72 w-72 rounded-full bg-sky-400/20 blur-[120px]" />

      <h1 className="relative z-10 bg-gradient-to-r from-cyan-200 via-white to-sky-200 bg-clip-text text-5xl font-bold tracking-tight text-transparent md:text-7xl">
        ACP.ai
      </h1>

      <div className="relative z-10 mt-7 h-1 w-52 overflow-hidden rounded-full bg-foreground/10">
        <div
          className="h-full w-1/2 rounded-full bg-gradient-to-r from-cyan-400 to-sky-400"
          style={{
            animation: "acp-load-slide 1.1s cubic-bezier(0.22,1,0.36,1) infinite",
          }}
        />
      </div>

      <p className="relative z-10 mt-4 text-xs tracking-widest text-muted uppercase">
        Loading…
      </p>

      <style>{`
        @keyframes acp-load-slide {
          0% { transform: translateX(-120%); }
          100% { transform: translateX(260%); }
        }
      `}</style>
    </div>
  );
}
