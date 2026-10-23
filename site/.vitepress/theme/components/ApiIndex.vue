<script setup lang="ts">
import { computed, ref } from "vue";
import { withBase } from "vitepress";
import { data } from "../../../api/index.data";

const KIND_LETTER: Record<string, string> = { class: "C", interface: "I", enum: "E", record: "R", annotation: "@" };

const query = ref("");

const matches = (name: string, summary: string) => {
  const q = query.value.trim().toLowerCase();
  return !q || name.toLowerCase().includes(q) || summary.toLowerCase().includes(q);
};

const packages = computed(() =>
  data.packages
    .map((p) => ({ ...p, shown: p.types.filter((t) => matches(t.name, t.summary)) }))
    .filter((p) => p.shown.length || matches(p.name, p.summary)),
);
const publicPackages = computed(() => packages.value.filter((p) => !p.internal));
const internalPackages = computed(() => packages.value.filter((p) => p.internal));
</script>

<template>
  <div class="api-index">
    <p class="eyebrow">API reference</p>
    <h1>MayhemLib Javadoc</h1>
    <p class="lede">
      Every public class in <code>mayhemlib</code>, generated from the source on each release. Most robot code only
      needs <a href="#auto">mayhemlib.auto</a>.
    </p>

    <div class="toolbar">
      <label class="filter">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input v-model="query" type="search" placeholder="Filter classes, e.g. Recovery" aria-label="Filter classes" />
      </label>
      <span class="coord">mayhemlib:MayhemLib-java:{{ data.version }}</span>
      <a class="classic" href="https://ryanabraham1.github.io/Mayhem/javadoc/" target="_blank" rel="noreferrer">Classic Javadoc ↗</a>
    </div>

    <div class="grid">
      <section v-for="p in publicPackages" :id="p.slug" :key="p.slug" class="pkg">
        <div class="pkg-head">
          <h2>{{ p.name }}</h2>
          <span v-if="p.slug === 'auto'" class="start">Start here</span>
        </div>
        <p class="pkg-summary" v-html="p.summary.replace(/<[^>]+>/g, '')" />
        <ul>
          <li v-for="t in p.shown" :key="t.name">
            <a :href="withBase(t.link)" :title="t.summary">
              <span :class="['api-kind', `api-kind-${t.kind}`]">{{ KIND_LETTER[t.kind] }}</span>{{ t.name }}
            </a>
          </li>
        </ul>
      </section>
    </div>

    <div v-if="internalPackages.length" class="internals">
      <span class="internals-title">Internals</span>
      <span v-for="p in internalPackages" :id="p.slug" :key="p.slug" class="internal">
        <span class="internal-pkg">{{ p.name }}</span>
        <template v-for="(t, i) in p.shown" :key="t.name">
          <span v-if="i">, </span><a :href="withBase(t.link)" :title="t.summary">{{ t.name }}</a>
        </template>
      </span>
      <span class="internals-note">Public, but most teams never touch them.</span>
    </div>

    <p v-if="!packages.length" class="empty">No classes match “{{ query }}”.</p>
  </div>
</template>

<style scoped>
.api-index {
  padding-top: 8px;
}
.eyebrow {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}
h1 {
  margin: 10px 0 0;
  font-size: 40px;
  line-height: 1.1;
  letter-spacing: -0.03em;
  font-weight: 600;
}
.lede {
  margin: 14px 0 0;
  max-width: 640px;
  font-size: 17px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.lede code,
.coord {
  font-family: var(--vp-font-family-mono);
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 28px;
}
.filter {
  flex: 1 1 320px;
  max-width: 480px;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  color: var(--vp-c-text-3);
}
.filter:focus-within {
  border-color: var(--vp-c-brand-1);
}
.filter input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 15px;
  color: var(--vp-c-text-1);
  outline: none;
}
.coord {
  display: inline-flex;
  align-items: center;
  height: 44px;
  padding: 0 14px;
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.classic {
  font-size: 13px;
  color: var(--vp-c-text-3);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  margin-top: 40px;
}
.pkg {
  padding: 22px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  transition: border-color 0.2s;
  scroll-margin-top: 90px;
}
.pkg:hover {
  border-color: var(--vp-c-brand-soft-border);
}
.pkg-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.pkg h2 {
  margin: 0;
  padding: 0;
  border: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0;
  line-height: 1.5;
}
.start {
  font-size: 11px;
  font-weight: 500;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  border-radius: 4px;
  padding: 1px 6px;
  white-space: nowrap;
}
.pkg-summary {
  margin: 8px 0 14px;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}
.pkg ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.pkg li a {
  display: flex;
  align-items: center;
  padding: 4px 0;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  color: var(--vp-c-text-1);
  text-decoration: none;
}
.pkg li a:hover {
  color: var(--vp-c-brand-1);
}
.internals {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px 24px;
  margin-top: 16px;
  padding: 18px 22px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  font-size: 13.5px;
  color: var(--vp-c-text-2);
}
.internals-title {
  font-weight: 500;
  color: var(--vp-c-text-1);
}
.internal {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
}
.internal-pkg {
  margin-right: 8px;
  color: var(--vp-c-text-3);
}
.empty {
  color: var(--vp-c-text-2);
}
</style>
