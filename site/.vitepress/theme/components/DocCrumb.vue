<script setup lang="ts">
// "MayhemLib / On the robot" above a guide page's title, from the nav and sidebar config.
import { computed } from "vue";
import { useData } from "vitepress";
import type { DefaultTheme } from "vitepress";

const { page, theme, frontmatter } = useData<DefaultTheme.Config>();

const crumbs = computed(() => {
  if (frontmatter.value.pageClass?.startsWith("api-")) return [];
  const path = "/" + page.value.relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
  const parts: string[] = [];
  const navItem = (theme.value.nav ?? []).find(
    (n): n is DefaultTheme.NavItemWithLink => "activeMatch" in n && !!n.activeMatch && path.startsWith(n.activeMatch),
  );
  if (navItem) parts.push(navItem.text);
  const sidebar = theme.value.sidebar;
  if (sidebar && !Array.isArray(sidebar)) {
    const key = Object.keys(sidebar).find((k) => path.startsWith(k));
    const groups = key ? sidebar[key] : [];
    const groupList = Array.isArray(groups) ? groups : groups.items;
    const group = groupList.find((g) => g.items?.some((i) => i.link === path));
    if (group?.text && group.text !== navItem?.text) parts.push(group.text);
  }
  return parts;
});
</script>

<template>
  <div v-if="crumbs.length" class="doc-crumb">
    <template v-for="(c, i) in crumbs" :key="c">
      <span v-if="i" class="sep">/</span><span>{{ c }}</span>
    </template>
  </div>
</template>
