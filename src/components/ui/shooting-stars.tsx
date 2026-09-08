"use client";

import { useCallback, useEffect, useRef } from "react";
import { THEME_CHANGE_EVENT, themeParticleRgb } from "@/lib/use-theme";

interface ShootingStar {
  x: number;
  y: number;
  length: number;
  speed: number;
  opacity: number;
  delay: number;
  life: number;
  angle: number;
}

export function ShootingStars({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const starsRef = useRef<ShootingStar[]>([]);
  const rafRef = useRef(0);

  const createStar = useCallback((w: number, h: number): ShootingStar => ({
    x: Math.random() * w * 1.5,
    y: Math.random() * h * 0.3,
    length: Math.random() * 120 + 60,
    speed: Math.random() * 10 + 6,
    opacity: Math.random() * 0.5 + 0.1,
    delay: Math.random() * 8000 + 2000,
    life: 0,
    angle: Math.PI / 4 + (Math.random() - 0.5) * 0.3,
  }), []);

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
    starsRef.current = Array.from({ length: 3 }, () => createStar(rect.width, rect.height));

    let lastFrame = 0;
    const FRAME_INTERVAL = 33;

    let particleRgb = themeParticleRgb();
    let opacityScale = 1;
    const onTheme = () => {
      particleRgb = themeParticleRgb();
      // Long streaks read as scratches on a light canvas — keep them, but
      // whisper-quiet (the twinkle-star dots stay full strength).
      opacityScale = document.documentElement.classList.contains("light") ? 0.55 : 1;
    };
    onTheme();
    window.addEventListener(THEME_CHANGE_EVENT, onTheme);

    const animate = (now: number) => {
      rafRef.current = requestAnimationFrame(animate);
      if (document.hidden || now - lastFrame < FRAME_INTERVAL) return;
      lastFrame = now;

      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      for (const star of starsRef.current) {
        if (star.delay > 0 && star.life === 0) {
          star.delay -= 16;
          continue;
        }

        star.life += 16;
        const progress = star.life / 1000;

        if (progress > 1) {
          Object.assign(star, createStar(w, h));
          continue;
        }

        const alpha = progress < 0.1 ? progress / 0.1 : progress > 0.8 ? 1 - (progress - 0.8) / 0.2 : 1;
        const x = star.x + Math.cos(star.angle) * star.speed * progress * 15;
        const y = star.y + Math.sin(star.angle) * star.speed * progress * 15;

        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(
          x - Math.cos(star.angle) * star.length * (1 - progress),
          y - Math.sin(star.angle) * star.length * (1 - progress),
        );
        ctx.strokeStyle = `rgba(${particleRgb},${star.opacity * alpha * opacityScale})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${particleRgb},${star.opacity * alpha * opacityScale})`;
        ctx.fill();
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      window.removeEventListener(THEME_CHANGE_EVENT, onTheme);
    };
  }, [createStar]);

  return <canvas ref={canvasRef} className={className} />;
}
