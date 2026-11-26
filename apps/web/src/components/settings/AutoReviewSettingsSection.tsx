import {
  ProviderInstanceId,
  type AutoReviewConfigPatch,
  type AutoReviewDefaultProjectMode,
  type AutoReviewOverride,
} from "@t3tools/contracts";
import { ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT } from "gt-react";

import {
  updateAutoReviewConfig,
  useAutoReviewSnapshot,
  useAutoReviewSubscription,
} from "~/autoReview/store";
import { useWorkspacePreparedConnection } from "~/environments/workspaceHttp";
import { useProjects } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const AUTO_MODEL_VALUE = "__auto__";

export function AutoReviewSettingsSection() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { environmentId: workspaceEnvironmentId, connectionKey: workspaceConnectionKey } =
    useWorkspacePreparedConnection();
  useAutoReviewSubscription(workspaceEnvironmentId, workspaceConnectionKey);
  const snapshot = useAutoReviewSnapshot();
  const { config } = snapshot;

  const providersByEnvironment = useEnvironmentProviders();
  const primaryProviders =
    workspaceEnvironmentId === null
      ? []
      : (providersByEnvironment.get(workspaceEnvironmentId) ?? []);
  const allProjects = useProjects();
  const primaryProjects =
    workspaceEnvironmentId === null
      ? []
      : allProjects.filter((project) => project.environmentId === workspaceEnvironmentId);

  const [saving, setSaving] = useState(false);
  const [draftInstructions, setDraftInstructions] = useState<string | null>(null);
  const currentInstructions = draftInstructions ?? config.customInstructions;
  const instructionsDirty =
    draftInstructions !== null && draftInstructions !== config.customInstructions;

  const commitPatch = async (patch: AutoReviewConfigPatch) => {
    setSaving(true);
    try {
      await updateAutoReviewConfig(patch);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Failed to update Auto-Review settings"),
        description: error instanceof Error ? error.message : gt("An error occurred."),
      });
    } finally {
      setSaving(false);
    }
  };

  const modelOptions: Array<{
    readonly value: string;
    readonly label: string;
    readonly target: { readonly instanceId: ProviderInstanceId; readonly model: string } | null;
  }> = [
    {
      value: AUTO_MODEL_VALUE,
      label: gt("Auto (prefer a different provider)"),
      target: null,
    },
    ...primaryProviders
      .filter((provider) => provider.enabled && provider.installed)
      .flatMap((provider) =>
        provider.models
          .filter((model) => model.isLegacy !== true)
          .map((model) => ({
            value: `${provider.instanceId}::${model.slug}`,
            label: `${provider.instanceId} · ${model.name || model.slug}`,
            target: {
              instanceId: provider.instanceId,
              model: model.slug,
            },
          })),
      ),
  ];

  const selectedModelValue =
    config.reviewerModel === null
      ? AUTO_MODEL_VALUE
      : `${config.reviewerModel.instanceId}::${config.reviewerModel.model}`;
  const selectedModelLabel =
    modelOptions.find((option) => option.value === selectedModelValue)?.label ??
    (config.reviewerModel
      ? `${config.reviewerModel.instanceId} · ${config.reviewerModel.model}`
      : gt("Auto (prefer a different provider)"));

  const projectModeLabels: Record<AutoReviewDefaultProjectMode, string> = {
    opt_out: gt("All projects (opt-out)"),
    opt_in: gt("Selected projects only (opt-in)"),
  };

  const overrideLabels: Record<"inherit" | AutoReviewOverride, string> = {
    inherit: gt("Follow default"),
    enabled: gt("Always on"),
    disabled: gt("Off"),
  };

  const disabled = workspaceEnvironmentId === null || saving;

  return (
    <SettingsSection
      id="auto-review-section"
      title={gt("Auto-Review")}
      icon={<ShieldCheckIcon aria-hidden className="size-4 text-muted-foreground" />}
    >
      <SettingsRow
        {...searchableSetting("auto-review")}
        description={gt(
          "Automatically launch an isolated, read-only Reviewer thread after top-level threads finish. Verified issues trigger bounded rework; decisions and exhausted retries escalate to Needs you.",
        )}
        control={
          <Switch
            checked={config.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => {
              void commitPatch({ enabled: Boolean(checked) });
            }}
            aria-label={gt("Independent Auto-Review")}
          />
        }
      />

      <SettingsRow
        title={gt("Default project coverage")}
        description={gt(
          "Choose whether projects are auto-reviewed by default or only when explicitly enabled below.",
        )}
        control={
          <Select
            value={config.defaultProjectMode}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === "opt_out" || value === "opt_in") {
                void commitPatch({ defaultProjectMode: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-56" aria-label={gt("Default project coverage")}>
              <SelectValue>{projectModeLabels[config.defaultProjectMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="opt_out">{projectModeLabels.opt_out}</SelectItem>
              <SelectItem value="opt_in">{projectModeLabels.opt_in}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title={gt("Reviewer model")}
        description={gt(
          "Cross-model review automatically chooses a different ready provider from the worker thread to reduce blind spots.",
        )}
        control={
          <Select
            value={selectedModelValue}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === null) return;
              const match = modelOptions.find((option) => option.value === value);
              if (!match) return;
              void commitPatch({ reviewerModel: match.target });
            }}
          >
            <SelectTrigger size="sm" className="w-64" aria-label={gt("Reviewer model")}>
              <SelectValue>{selectedModelLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {modelOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title={gt("Max automatic rework rounds")}
        description={gt(
          "Server-enforced limit per user task. Set to 0 for review-only mode without automatic rework.",
        )}
        control={
          <Select
            value={String(config.maxReworkRounds)}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === null) return;
              const parsed = Number(value);
              if (Number.isFinite(parsed)) {
                void commitPatch({ maxReworkRounds: parsed });
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-44"
              aria-label={gt("Max automatic rework rounds")}
            >
              <SelectValue>
                {config.maxReworkRounds === 0
                  ? gt("0 (review only)")
                  : gt("{count, plural, one {{count} round} other {{count} rounds}}", {
                      count: config.maxReworkRounds,
                    })}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {[0, 1, 2, 3].map((rounds) => (
                <SelectItem key={rounds} value={String(rounds)}>
                  {rounds === 0
                    ? gt("0 (review only)")
                    : gt("{count, plural, one {{count} round} other {{count} rounds}}", {
                        count: rounds,
                      })}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title={gt("Concurrent reviews")}
        description={gt("Maximum isolated Reviewer threads allowed to run at the same time.")}
        control={
          <Select
            value={String(config.maxConcurrency)}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === null) return;
              const parsed = Number(value);
              if (Number.isFinite(parsed)) {
                void commitPatch({ maxConcurrency: parsed });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-28" aria-label={gt("Concurrent reviews")}>
              <SelectValue>{String(config.maxConcurrency)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {[1, 2, 3, 4].map((limit) => (
                <SelectItem key={limit} value={String(limit)}>
                  {String(limit)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      {primaryProjects.length > 0 ? (
        <SettingsRow
          title={gt("Per-project overrides")}
          description={gt("Override automatic review for individual projects.")}
        >
          <div className="mt-2 flex flex-col divide-y divide-border/50 rounded-md border border-border/60">
            {primaryProjects.map((project) => {
              const currentOverride: "inherit" | AutoReviewOverride =
                config.projectOverrides[project.id] ?? "inherit";
              return (
                <div
                  key={project.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                >
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {project.title}
                  </span>
                  <Select
                    value={currentOverride}
                    disabled={disabled}
                    onValueChange={(value) => {
                      if (value !== "inherit" && value !== "enabled" && value !== "disabled")
                        return;
                      void commitPatch({
                        projectOverrides: {
                          [project.id]: value === "inherit" ? null : value,
                        },
                      });
                    }}
                  >
                    <SelectTrigger
                      size="xs"
                      className="w-36 shrink-0"
                      aria-label={gt("Auto-review override for {project}", {
                        project: project.title,
                      })}
                    >
                      <SelectValue>{overrideLabels[currentOverride]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="inherit">{overrideLabels.inherit}</SelectItem>
                      <SelectItem value="enabled">{overrideLabels.enabled}</SelectItem>
                      <SelectItem value="disabled">{overrideLabels.disabled}</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>
              );
            })}
          </div>
        </SettingsRow>
      ) : null}

      <SettingsRow
        title={gt("Custom review checklist")}
        description={gt(
          "Optional standing criteria appended to every Reviewer prompt (for example, test requirements or safety checks).",
        )}
      >
        <div className="mt-2 flex flex-col gap-2">
          <Textarea
            size="sm"
            rows={3}
            disabled={disabled}
            value={currentInstructions}
            placeholder={gt(
              "Example: Verify typecheck and unit tests were executed; escalate any schema or API breaking changes.",
            )}
            onChange={(event) => setDraftInstructions(event.target.value)}
            aria-label={gt("Custom review checklist")}
          />
          {instructionsDirty ? (
            <div className="flex items-center justify-end gap-2">
              <Button
                size="xs"
                variant="ghost"
                disabled={saving}
                onClick={() => setDraftInstructions(null)}
              >
                <T>Cancel</T>
              </Button>
              <Button
                size="xs"
                disabled={saving}
                onClick={() => {
                  void commitPatch({ customInstructions: currentInstructions }).then(() => {
                    setDraftInstructions(null);
                  });
                }}
              >
                <T>Save checklist</T>
              </Button>
            </div>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
