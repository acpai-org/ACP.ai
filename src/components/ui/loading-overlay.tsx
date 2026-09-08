"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { SparklesCore } from "./sparkles";

export function LoadingOverlay() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timeout = setTimeout(() => setVisible(false), 800);
    return () => clearTimeout(timeout);
  }, []);

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="loading-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: "easeInOut" }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[var(--page-bg)]"
        >
          {/* N10: the wordmark is the hero on every screen size — mobile
              included (was text-3xl ≈ 30px on a 390px phone; now 48px). */}
          <h1 className="relative z-20 text-center text-5xl font-bold tracking-tight text-foreground sm:text-6xl md:text-7xl lg:text-9xl">
            ACP.ai
          </h1>
          {/* N10: the "noise" strip is small and THIN on mobile like desktop —
              a beam under the wordmark, not a huge block. */}
          <div className="relative h-10 w-[min(24rem,86vw)] sm:h-12 md:w-[40rem]">
            <div className="absolute inset-x-16 top-0 h-[2px] w-3/4 bg-gradient-to-r from-transparent via-cyan-400 to-transparent blur-sm" />
            <div className="absolute inset-x-16 top-0 h-px w-3/4 bg-gradient-to-r from-transparent via-cyan-400 to-transparent" />
            <div className="absolute inset-x-auto left-1/2 top-0 h-[5px] w-1/4 -translate-x-1/2 bg-gradient-to-r from-transparent via-sky-400 to-transparent blur-sm" />
            <div className="absolute inset-x-auto left-1/2 top-0 h-px w-1/4 -translate-x-1/2 bg-gradient-to-r from-transparent via-sky-400 to-transparent" />
            <SparklesCore
              background="transparent"
              minSize={0.4}
              maxSize={1}
              particleDensity={1200}
              className="h-full w-full"
            />
            {/* Fade-out mask for the sparkles (the old markup carried a
                corrupted `ask-image:…` class name — the mask never applied). */}
            <div className="pointer-events-none absolute inset-0 h-full w-full bg-[var(--page-bg)] [mask-image:radial-gradient(65%_60%_at_50%_40%,transparent_20%,white)]" />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
