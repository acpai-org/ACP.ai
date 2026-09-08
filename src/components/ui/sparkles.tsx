"use client";

import { useEffect, useRef, useState } from "react";
import { useThemedParticleColor } from "@/lib/use-theme";

interface SparklesCoreProps {
  background?: string;
  minSize?: number;
  maxSize?: number;
  particleDensity?: number;
  className?: string;
  /** Fixed css color; omit to follow the active light/dark palette. */
  particleColor?: string;
}

interface Particle {
  x: number;
  y: number;
  size: number;
  speedX: number;
  speedY: number;
  opacity: number;
  life: number;
}

export function SparklesCore({
  background = "transparent",
  minSize = 0.4,
  maxSize = 1,
  particleDensity = 1200,
  className,
  particleColor,
}: SparklesCoreProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dimensions, setDimensions] = useState({ w: 0, h: 0 });
  const particlesRef = useRef<Particle[]>([]);
  const rafRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  // Theme-following particle tint (external store; explicit prop wins).
  const resolvedColor = useThemedParticleColor(particleColor);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resize = () => {
      if (resizeTimer !== null) return;
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        setDimensions({ w: rect.width, h: rect.height });

        const ctx = canvas.getContext("2d");
        if (ctx) ctx.scale(dpr, dpr);
      }, 100);
    };

    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
    };
  }, []);

  useEffect(() => {
    if (!dimensions.w || !dimensions.h) return;

    const count = Math.min(
      Math.floor((dimensions.w * dimensions.h) / (10000 / particleDensity)),
      5000,
    );

    particlesRef.current = Array.from({ length: count }, () => ({
      x: Math.random() * dimensions.w,
      y: Math.random() * dimensions.h,
      size: minSize + Math.random() * (maxSize - minSize),
      speedX: (Math.random() - 0.5) * 0.3,
      speedY: (Math.random() - 0.5) * 0.3,
      opacity: 0.1 + Math.random() * 0.6,
      life: 0,
    }));
  }, [dimensions, minSize, maxSize, particleDensity]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let lastFrame = 0;
    const FRAME_INTERVAL = 33;

    const animate = (timestamp: number) => {
      rafRef.current = requestAnimationFrame(animate);
      if (document.hidden || timestamp - lastFrame < FRAME_INTERVAL) return;
      lastFrame = timestamp;

      timeRef.current = timestamp;
      const dpr = window.devicePixelRatio || 1;

      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

      for (const p of particlesRef.current) {
        p.x += p.speedX;
        p.y += p.speedY;
        p.life += 0.005;

        if (p.x < 0 || p.x > dimensions.w) p.speedX *= -1;
        if (p.y < 0 || p.y > dimensions.h) p.speedY *= -1;

        const pulseOpacity = p.opacity * (0.6 + 0.4 * Math.sin(p.life));
        const pulseSize = p.size * (0.8 + 0.2 * Math.sin(p.life * 1.3));

        ctx.beginPath();
        ctx.arc(p.x, p.y, pulseSize, 0, Math.PI * 2);
        ctx.fillStyle = resolvedColor;
        ctx.globalAlpha = pulseOpacity;
        ctx.fill();
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [dimensions, resolvedColor]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ background }}
    />
  );
}
