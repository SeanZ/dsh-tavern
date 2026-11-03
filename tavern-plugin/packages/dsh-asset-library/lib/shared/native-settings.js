// Generated from Tavern host settings by build.mjs; do not edit.
function entryOf(ctx) {
  // alpha.3 配置条目持有运行 Fiber，其 ctx.fiber 才是插件上下文身份；旧宿主保留直接比较。
  const entry = ctx.get('configEditor')?.entries().find(row => row.fiber === ctx.fiber || row.fiber?.ctx?.fiber === ctx.fiber)
  if (!entry) throw new Error('Native settings owner is not a profile entry')
  return entry
}

function entryId(ctx) { return entryOf(ctx).options.id }

// Legacy providers own sections; 0.2.1 forms own volatile fields of a profile entry.
export function installSettingsSection(ctx, provider, section, schema, defaults, hooks) {
  if (typeof provider.installSection === 'function') return provider.installSection(ctx, section, schema, defaults, hooks)
  hooks.setSource(() => {
    // alpha.3 的 config 是下一次启动的原始输入；热更新后的运行值在 effectiveConfig。
    const config = entryOf(ctx).fiber.effectiveConfig ?? ctx.fiber.config
    return (hooks.validate || schema)(config[section]?.get() ?? defaults)
  })
  ctx.on('settings/document-updated', ns => { if (ns === entryId(ctx)) hooks.onChange?.() })
}

export function settingsSectionProvider(ctx, section) {
  const provider = ctx.get('settings')
  if (!provider || typeof provider.installSection === 'function') return provider
  return {
    get writable() { return provider.writable !== false },
    describe() { return provider.describe().filter(row => row.ns === entryId(ctx)).map(row => ({ ...row, ns: section, value: row.value[section] })) },
    async replace(name, value, revision) {
      if (name !== section || revision === undefined) throw new Error('Native settings section revision is unavailable')
      await provider.mutate(entryId(ctx), [{ op: 'set', path: [section], value }], revision)
    },
  }
}

export const nativeSettingsEntryId = entryId
