"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ShieldCheck,
  KeyRound,
  Database,
  Landmark,
  Lock,
  BadgeCheck,
  ExternalLink,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { motion } from "motion/react";
import { PageContainer } from "@/components/page-container";
import { Card, StatCard } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { useI18n } from "@/lib/i18n";
import { TOOL_REGISTRY, type RiskClass } from "@/lib/agent/tool-registry";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Security page (N28 rebuild): every value on this page is either a LIVE
// fact (the agent policy from /api/agent/policy — same store the loop
// enforces), a structural fact (the actual closed toolset from the real
// registry), or a custody fact (where keys/data actually live). The Phase-1
// mock audit log / fake 2FA / fake recovery-phrase viewer / mock permission
// list are GONE — no mock data renders anywhere in this app.
// ─────────────────────────────────────────────────────────────────────────────

interface DeployPolicyState {
  mainnetDeployOptIn: boolean;
  dismissedCustomDeployWarning: boolean;
}

const RISK_ORDER: RiskClass[] = ["funds", "deploy", "privilege", "config", "read"];

const RISK_KEY: Record<RiskClass, "security.riskFunds" | "security.riskDeploy" | "security.riskPrivilege" | "security.riskConfig" | "security.riskRead"> = {
  funds: "security.riskFunds",
  deploy: "security.riskDeploy",
  privilege: "security.riskPrivilege",
  config: "security.riskConfig",
  read: "security.riskRead",
};

const RISK_STYLE: Record<RiskClass, string> = {
  funds: "bg-primary/10 text-primary",
  deploy: "bg-warning/10 text-warning",
  privilege: "bg-danger/10 text-danger",
  config: "bg-surface-3 text-muted",
  read: "bg-success/10 text-success",
};

const sectionSpring = { duration: 0.35, delay: 0.12, ease: [0.22, 1, 0.36, 1] as const };

export default function SecurityPage() {
  const { t } = useI18n();
  const [policy, setPolicy] = useState<DeployPolicyState | null>(null);
  const [policyError, setPolicyError] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Live policy fetch: setState ONLY inside async callbacks (the documented
  // effect pattern — no synchronous setState reachable from the effect body).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent/policy", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("bad status");
        return res.json() as Promise<{ policy: DeployPolicyState }>;
      })
      .then((body) => {
        if (cancelled) return;
        setPolicy(body.policy);
        setPolicyError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setPolicyError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const setMainnetOptIn = useCallback(
    async (next: boolean) => {
      setPolicyBusy(true);
      try {
        const res = await fetch("/api/agent/policy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "update", patch: { mainnetDeployOptIn: next } }),
        });
        if (!res.ok) throw new Error("bad status");
        const body = (await res.json()) as { policy: DeployPolicyState };
        setPolicy(body.policy);
        setPolicyError(false);
      } catch {
        setPolicyError(true);
      } finally {
        setPolicyBusy(false);
      }
    },
    [],
  );

  // Structural facts from the REAL registry (imported, not restated).
  const tools = useMemo(() => Object.values(TOOL_REGISTRY), []);
  const byRisk = useMemo(() => {
    const m = new Map<RiskClass, number>();
    for ( const tool of tools) m.set(tool.risk, (m.get(tool.risk) ?? 0) + 1);
    return m;
  }, [tools]);
  const walletSigned = useMemo(() => tools.filter((tool) => tool.executor === "client").length, [tools]);

  return (
    <PageContainer
      title={t("security.title")}
      description={t("security.desc")}
      icon={<ShieldCheck className="h-5 w-5" />}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label={t("security.toolsetTitle")} value={t("security.toolCount", { count: String(tools.length) })} />
        <StatCard label={t("security.execClient")} value={t("security.toolCount", { count: String(walletSigned) })} sublabel={t("security.riskFunds")} />
        <StatCard label={t("security.attestTitle")} value={<span className="inline-flex items-center gap-1.5"><BadgeCheck className="h-4 w-4 text-success" />Creditcoin</span>} className="col-span-2 sm:col-span-1" />
      </div>

      <Card>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted" />
            <h2 className="text-sm font-semibold text-foreground">{t("security.guardrails")}</h2>
          </div>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2/60 hover:text-foreground"
            aria-label={t("security.reloadPolicy")}
            title={t("security.reloadPolicy")}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mb-3 text-xs text-muted">{t("security.guardrailsDesc")}</p>

        {policyError ? (
          <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-[13px] text-warning">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{t("security.policyLoadFailed")}</span>
          </div>
        ) : policy ? (
          <div className="space-y-2">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={sectionSpring}
              className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 transition-colors hover:border-warning/30 hover:bg-warning/5"
            >
              <div>
                <p className="text-sm font-medium text-foreground">{t("security.mainnetDeploy")}</p>
                <p className="mt-0.5 text-xs text-muted-2">{t("security.mainnetDeployDesc")}</p>
              </div>
              <Toggle
                checked={policy.mainnetDeployOptIn}
                disabled={policyBusy}
                onChange={() => void setMainnetOptIn(!policy.mainnetDeployOptIn)}
              />
            </motion.div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t("security.customWarning")}</p>
                <p className="mt-0.5 text-xs text-muted-2">{t("security.customWarningDesc")}</p>
              </div>
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium",
                  policy.dismissedCustomDeployWarning ? "bg-surface-3 text-muted" : "bg-primary/10 text-primary",
                )}
              >
                {policy.dismissedCustomDeployWarning ? t("security.warnStateDismissed") : t("security.warnStateShown")}
              </span>
            </div>
          </div>
        ) : (
          <div className="h-16 animate-pulse rounded-xl bg-surface-2/60" aria-hidden />
        )}
      </Card>

      <Card className="p-0">
        <div className="flex items-center gap-2 px-5 pt-5">
          <Landmark className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-foreground">{t("security.toolsetTitle")}</h2>
          <span className="ml-auto text-xs text-muted">{t("security.toolCount", { count: String(tools.length) })}</span>
        </div>
        <p className="px-5 pt-1 text-xs text-muted">{t("security.toolsetDesc")}</p>
        <div className="acp-scroll mt-3 max-h-96 overflow-y-auto px-5 pb-5">
          <div className="space-y-1.5">
            {tools.map((tool) => (
              <div
                key={tool.name}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-surface-2/30 px-3 py-2"
              >
                <code className="min-w-0 truncate font-mono text-[12.5px] text-foreground">{tool.name}</code>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                      RISK_STYLE[tool.risk],
                    )}
                  >
                    {t(RISK_KEY[tool.risk])}
                  </span>
                  <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10.5px] font-medium text-muted">
                    {tool.executor === "client" ? t("security.execClient") : t("security.execServer")}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          {RISK_ORDER.filter((r) => byRisk.get(r)).map((r) => (
            <span key={r} className="text-[11px] text-muted-2">
              {t(RISK_KEY[r])}: {byRisk.get(r)}
            </span>
          ))}
        </div>
      </Card>

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-foreground">{t("security.keysTitle")}</h2>
        </div>
        <p className="text-sm font-medium text-foreground">{t("security.keysIntro")}</p>
        <ul className="mt-2 space-y-1.5">
          {[t("security.keysPoint1"), t("security.keysPoint2"), t("security.keysPoint3")].map((point, i) => (
            <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-muted">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <Database className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-foreground">{t("security.dataTitle")}</h2>
        </div>
        <ul className="space-y-1.5">
          {[t("security.dataPoint1"), t("security.dataPoint2"), t("security.dataPoint3")].map((point, i) => (
            <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-muted">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <BadgeCheck className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-foreground">{t("security.attestTitle")}</h2>
        </div>
        <p className="text-xs leading-relaxed text-muted">{t("security.attestDesc")}</p>
        <a
          href="https://docs.attestcoin.org"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-primary transition-colors hover:border-primary/40 hover:bg-primary/5"
        >
          {t("security.attestLink")}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      </Card>
    </PageContainer>
  );
}
