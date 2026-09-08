"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { useI18n } from "@/lib/i18n";

// ─────────────────────────────────────────────────────────────────────────────
// DeployPolicyCard (Phase 3): the surviving per-user deploy preferences after
// the mandate removal (C26). The session mandate, ceilings, and windows are
// gone — what remains is the mainnet-deployment opt-in ([retained default]:
// off). The dismissible custom-generation warning state is server-side and
// is surfaced where it matters (in the deploy confirmation flow), not here.
// ─────────────────────────────────────────────────────────────────────────────

interface DeployPolicy {
  mainnetDeployOptIn: boolean;
  dismissedCustomDeployWarning: boolean;
}

export function DeployPolicyCard() {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ policy: DeployPolicy }>({
    queryKey: ["agent-policy"],
    queryFn: async () => {
      const res = await fetch("/api/agent/policy", { cache: "no-store" });
      if (!res.ok) throw new Error("policy fetch failed");
      return res.json();
    },
    staleTime: 30_000,
  });

  const update = useMutation({
    mutationFn: async (mainnetDeployOptIn: boolean) => {
      const res = await fetch("/api/agent/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "update", patch: { mainnetDeployOptIn } }),
      });
      if (!res.ok) throw new Error("policy update failed");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-policy"] });
    },
  });

  const pending = update.isPending;
  const optIn = data?.policy.mainnetDeployOptIn ?? false;

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-muted" />
        <h2 className="text-sm font-semibold text-foreground">{t("deployPolicy.title")}</h2>
      </div>
      <div className="divide-y divide-border">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
              <ShieldAlert className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">{t("deployPolicy.mainnetDeploy")}</p>
              <p className="text-xs text-muted-2">{t("deployPolicy.mainnetDeployDesc")}</p>
            </div>
          </div>
          <Toggle
            checked={optIn}
            disabled={isLoading || pending}
            onChange={() => {
              if (!isLoading && !pending) update.mutate(!optIn);
            }}
            aria-label={t("deployPolicy.mainnetDeploy")}
          />
        </div>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-2">{t("deployPolicy.mainnetDeployNote")}</p>
      {pending ? (
        <p className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-2">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          {t("deployPolicy.saving")}
        </p>
      ) : null}
    </Card>
  );
}
