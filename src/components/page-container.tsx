"use client";

import { motion } from "motion/react";
import { type ReactNode } from "react";

interface PageContainerProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}

export function PageContainer({
  title,
  description,
  icon,
  action,
  children,
}: PageContainerProps) {
  // U1: navbar capsule is 68px tall (48px logo) → bottom edge 80px
  // (mobile, top-3) / 84px (sm+, top-4). 4/8px clear, as before.
  return (
    <div className="h-full overflow-y-auto scroll-smooth pt-[84px] sm:pt-[92px]">
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8 space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="mb-6 flex items-start justify-between gap-4"
        >
          <div className="flex items-start gap-3">
            {icon ? (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                {icon}
              </div>
            ) : null}
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                {title}
              </h1>
              {description ? (
                <p className="mt-0.5 text-sm text-muted">{description}</p>
              ) : null}
            </div>
          </div>
          {action}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="glass-panel p-5 space-y-4">
            {children}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
