"use client";

import { useEffect, useRef } from "react";
import { THEME_CHANGE_EVENT, themeParticleRgb } from "@/lib/use-theme";

interface Star {
  x: number;
  y: number;
  size: number;
  opacity: number;
  twinkleSpeed: number;
  phase: number;
}

export function StarsBackground({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const starsRef = useRef<Star[]>([]);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    const rect = canvas.getBoundingClientRect();
    const count = Math.floor((rect.width * rect.height) / 3000);
    starsRef.current = Array.from({ length: count }, () => ({
      x: Math.random() * rect.width,
      y: Math.random() * rect.height,
      size: Math.random() * 1.8 + 0.3,
      opacity: Math.random() * 0.6 + 0.2,
      twinkleSpeed: Math.random() * 2 + 0.5,
      phase: Math.random() * Math.PI * 2,
    }));

    let lastFrame = 0;
    const FRAME_INTERVAL = 33;

    let particleRgb = themeParticleRgb();
    const onTheme = () => {
      particleRgb = themeParticleRgb();
    };
    window.addEventListener(THEME_CHANGE_EVENT, onTheme);

    const animate = (timestamp: number) => {
      rafRef.current = requestAnimationFrame(animate);
      if (document.hidden || timestamp - lastFrame < FRAME_INTERVAL) return;
      lastFrame = timestamp;

      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      for (const star of starsRef.current) {
        const twinkle = 0.5 + 0.5 * Math.sin(timestamp * 0.001 * star.twinkleSpeed + star.phase);
        const alpha = star.opacity * twinkle;

        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${particleRgb},${alpha})`;
        ctx.fill();
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      window.removeEventListener(THEME_CHANGE_EVENT, onTheme);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} />;
}
