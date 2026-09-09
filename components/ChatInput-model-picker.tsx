"use client";

import React, { useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { providerInitials } from "./ModelsConfig-types";
import type { ModelOption } from "./ChatInput-model-options";

export interface ProviderModelGroup {
  provider: string;
  options: ModelOption[];
}

export function groupModelOptionsByProvider(options: ModelOption[]): ProviderModelGroup[] {
  const groups: ProviderModelGroup[] = [];
  const byProvider = new Map<string, ProviderModelGroup>();
  for (const option of options) {
    let group = byProvider.get(option.provider);
    if (!group) {
      group = { provider: option.provider, options: [] };
      byProvider.set(option.provider, group);
      groups.push(group);
    }
    group.options.push(option);
  }
  return groups;
}

/** Current model's provider first so the picker opens on what you're already using. */
export function orderProviderGroups(groups: ProviderModelGroup[], currentProvider: string | null | undefined): ProviderModelGroup[] {
  if (!currentProvider) return groups;
  const index = groups.findIndex((g) => g.provider === currentProvider);
  if (index <= 0) return groups;
  const next = [...groups];
  const [active] = next.splice(index, 1);
  next.unshift(active);
  return next;
}

export function ProviderBadge({ id, size = 16 }: { id: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text-dim)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontSize: Math.max(8, Math.floor(size * 0.42)),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {providerInitials(id)}
    </span>
  );
}

export interface ModelPickerPanelProps {
  /** All visible options (already filtered by composer-picker visibility). */
  modelOptions: ModelOption[];
  /** Options matching the current search query. */
  filteredModelOptions: ModelOption[];
  currentModel?: { provider: string; modelId: string } | null;
  modelSearchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  showModelsLoading?: boolean;
  isMobile?: boolean;
  onSelectModel: (provider: string, modelId: string) => void;
  onOpenProviders?: () => void;
  onClose?: () => void;
}

/**
 * Codex-style nested model picker: providers on the right rail, that
 * provider's models on the left. Search flattens across providers.
 */
export function ModelPickerPanel({
  modelOptions,
  filteredModelOptions,
  currentModel,
  modelSearchQuery,
  onSearchQueryChange,
  searchInputRef,
  showModelsLoading,
  isMobile,
  onSelectModel,
  onOpenProviders,
  onClose,
}: ModelPickerPanelProps) {
  const { t } = useI18n();
  const searching = modelSearchQuery.trim().length > 0;
  const groups = useMemo(
    () => orderProviderGroups(groupModelOptionsByProvider(modelOptions), currentModel?.provider),
    [modelOptions, currentModel?.provider],
  );
  const filteredGroups = useMemo(
    () => orderProviderGroups(groupModelOptionsByProvider(filteredModelOptions), currentModel?.provider),
    [filteredModelOptions, currentModel?.provider],
  );

  // Provider selection is explicit. Hover-driven pane changes make the list
  // flicker while the pointer crosses the picker.
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const selectedProviderAvailable = groups.some((group) => group.provider === selectedProvider);
  const currentProviderAvailable = groups.some((group) => group.provider === currentModel?.provider);
  const activeProvider = selectedProviderAvailable
    ? selectedProvider
    : currentProviderAvailable
      ? currentModel?.provider ?? null
      : groups[0]?.provider ?? null;

  const leftModels = searching
    ? filteredModelOptions
    : (groups.find((group) => group.provider === activeProvider)?.options ?? []);

  const leftGroups = searching ? filteredGroups : null;
  const showProviderRail = !searching && (!isMobile || selectedProvider === null);
  const showModelPane = searching || !isMobile || selectedProvider !== null;

  const selectModel = (opt: ModelOption) => {
    onSelectModel(opt.provider, opt.modelId);
  };

  const renderModelRow = (opt: ModelOption, opts?: { showProvider?: boolean }) => {
    const isActive = Boolean(currentModel)
      && opt.modelId === currentModel?.modelId
      && opt.provider === currentModel?.provider;
    return (
      <button
        className="picker-row"
        data-active={isActive}
        type="button"
        key={`${opt.provider}:${opt.modelId}`}
        role="menuitemradio"
        aria-checked={isActive}
        onClick={() => selectModel(opt)}
      >
        <span className="picker-check">{isActive && <Check size={11} strokeWidth={2.4} aria-hidden="true" />}</span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {opt.name || opt.modelId}
        </span>
        {opts?.showProvider && (
          <span className="picker-row-meta">{opt.provider}</span>
        )}
      </button>
    );
  };

  return (
    <>
      <label className="picker-search">
        <Search size={13} strokeWidth={1.8} color="var(--text-dim)" aria-hidden="true" />
        <input
          ref={searchInputRef}
          type="search"
          autoComplete="off"
          spellCheck={false}
          value={modelSearchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose?.();
            }
          }}
          placeholder={t("chatInput.searchModels")}
          aria-label={t("chatInput.searchModels")}
        />
      </label>

      <div className="picker-nested" data-searching={searching ? "true" : "false"}>
        {showProviderRail && (
          <div className="picker-nested-providers" role="group" aria-label={t("chatInput.providersLabel")}>
            {groups.length === 0 ? (
              <div className="picker-empty">
                {showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noAvailableModels")}
              </div>
            ) : groups.map((group) => {
              const isCurrent = currentModel?.provider === group.provider;
              const isActive = activeProvider === group.provider;
              return (
                <button
                  key={group.provider}
                  type="button"
                  className="picker-row picker-provider-row"
                  data-active={isActive}
                  data-current={isCurrent}
                  onClick={() => setSelectedProvider(group.provider)}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-controls="model-picker-options"
                >
                  <ProviderBadge id={group.provider} size={15} />
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {group.provider}
                  </span>
                  <ChevronRight size={12} strokeWidth={1.8} style={{ marginLeft: "auto", flexShrink: 0, opacity: 0.55 }} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
        {showModelPane && (
          <div id="model-picker-options" className="picker-nested-models" role="group" aria-label={t("chatInput.modelsLabel")}>
            {isMobile && !searching && selectedProvider !== null && (
              <button
                type="button"
                className="picker-row"
                onClick={() => setSelectedProvider(null)}
                style={{ color: "var(--text-muted)" }}
              >
                <ChevronLeft size={13} strokeWidth={1.8} aria-hidden="true" />
                <span>{activeProvider}</span>
              </button>
            )}
            {searching ? (
              leftGroups && leftGroups.length > 0 ? (
                leftGroups.map((group) => (
                  <div key={group.provider}>
                    <div className="picker-group-label">{group.provider}</div>
                    {group.options.map((opt) => renderModelRow(opt))}
                  </div>
                ))
              ) : (
                <div className="picker-empty">
                  {showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noMatchingModels")}
                </div>
              )
            ) : leftModels.length === 0 ? (
              <div className="picker-empty">
                {showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noAvailableModels")}
              </div>
            ) : (
              leftModels.map((opt) => renderModelRow(opt))
            )}
          </div>
        )}
      </div>

      {onOpenProviders && (
        <button
          type="button"
          className="picker-row picker-add-providers"
          onClick={() => {
            onOpenProviders();
          }}
        >
          <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>{t("chatInput.addProviders")}</span>
        </button>
      )}
    </>
  );
}
