<script setup lang="ts">
import { ref } from "vue";
import { withBase } from "vitepress";

const repo = "https://github.com/ryanabraham1/Mayhem";
const vendordep = "https://ryanabraham1.github.io/Mayhem/MayhemLib.json";
const copied = ref(false);

async function copyVendordep() {
  try {
    await navigator.clipboard.writeText(vendordep);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // Clipboard blocked: the URL is still visible to select by hand.
  }
}

const cards = [
  {
    title: "Desktop app",
    text: "Projects, robot config, the field, paths, constraints and markers.",
    cta: "Build your first auto",
    link: "/guide/quick-start",
    icon: "M3 4h18v14H3zM8 21h8M12 18v3",
  },
  {
    title: "MayhemLib",
    text: "The WPILib 2026 vendordep: routines, triggers, recovery and tuning.",
    cta: "Robot quick start",
    link: "/lib/quick-start",
    icon: "M5 8h14v11H5zM12 4v4M9 13h.01M15 13h.01M3 13v2M21 13v2",
  },
  {
    title: "API reference",
    text: "Javadoc for every public class in mayhemlib, searchable alongside the guides.",
    cta: "Browse packages",
    link: "/api/",
    icon: "m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16",
  },
];

const features = [
  ["Physics-based", "Motor curves, current limits, traction, mass and inertia are hard limits in the optimizer, so paths are fast and drivable.", "/app/robot"],
  ["Routes around obstacles", "Collision checks use the robot's real, rotating bumper rectangle, and the result is verified with a swept check.", "/app/field"],
  ["Tells you what's wrong", "When a path can't be made, Mayhem names the waypoint or constraint that's the problem and pins it on the field.", "/app/troubleshooting"],
  ["Bump recovery", "If the robot is knocked off its path, MayhemLib detects the hit and takes the fastest feasible bridge back on.", "/lib/recovery"],
  ["Choreo-style API", "AutoFactory, routines and triggers you already know, with per-module force feedforward built in.", "/lib/from-choreo"],
  ["Fuel sim", "Play a path back with the 2026 FUEL, allies and opponents to see how an intake and a route interact.", "/app/fuel-sim"],
];
</script>

<template>
  <div class="home">
    <section class="hero">
      <h1>The fastest path your swerve can actually drive.</h1>
      <p class="lede">
        Place waypoints. Mayhem solves a time-optimal trajectory around real obstacles, and MayhemLib gets your robot
        back on it after a bump.
      </p>
      <div class="actions">
        <a class="btn btn-primary" :href="withBase('/guide/introduction')">Get started</a>
        <a class="btn btn-alt" :href="`${repo}/releases/latest`" target="_blank" rel="noreferrer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /></svg>
          Download the app
        </a>
        <div class="vendordep">
          <span class="vendordep-label">Vendordep</span>
          <code>{{ vendordep.replace("https://", "") }}</code>
          <button type="button" :aria-label="copied ? 'Copied' : 'Copy vendordep URL'" @click="copyVendordep">
            <svg v-if="!copied" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7" /></svg>
          </button>
        </div>
      </div>
    </section>

    <section class="shot">
      <img :src="withBase('/img/overview.jpg')" alt="The Mayhem desktop app with a generated path on the 2026 REBUILT field" />
    </section>

    <section class="section">
      <p class="eyebrow">Documentation</p>
      <h2>Start where you are</h2>
      <div class="cards">
        <a v-for="c in cards" :key="c.title" class="card" :href="withBase(c.link)">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="c.icon" /></svg>
          <span class="card-title">{{ c.title }}</span>
          <span class="card-text">{{ c.text }}</span>
          <span class="card-cta">{{ c.cta }} →</span>
        </a>
      </div>
    </section>

    <section class="section features">
      <a v-for="[title, text, link] in features" :key="title" class="feature" :href="withBase(link)">
        <span class="feature-title">{{ title }}</span>
        <span class="feature-text">{{ text }}</span>
      </a>
    </section>

    <section class="section code-section">
      <div class="code-copy">
        <p class="eyebrow">On the robot</p>
        <h2>A routine in a few lines</h2>
        <p>Markers you name in the app become triggers in your robot code. Every method is documented in the API reference.</p>
        <a :href="withBase('/api/auto/AutoTrajectory')">AutoTrajectory reference →</a>
      </div>
      <div class="code">
        <div class="code-title">RobotContainer.java</div>
        <pre><code><span class="t">AutoRoutine</span> routine = autoFactory.newRoutine(<span class="s">"Hub Cycle"</span>);
<span class="t">AutoTrajectory</span> toHub = routine.trajectory(<span class="s">"Hub Cycle"</span>, <span class="n">0</span>);

routine.active().onTrue(
    toHub.resetOdometry().andThen(toHub.cmd()));
toHub.atTime(<span class="s">"shoot"</span>).onTrue(shooter.shootOnce());
toHub.recovering().whileTrue(lights.flash());</code></pre>
      </div>
    </section>

    <footer class="foot">
      <span>Mayhem is an open-source FRC project. Not affiliated with FIRST, WPILib or Choreo.</span>
      <span class="foot-links">
        <a :href="repo" target="_blank" rel="noreferrer">GitHub</a>
        <a :href="`${repo}/releases`" target="_blank" rel="noreferrer">Releases</a>
      </span>
    </footer>
  </div>
</template>

<style scoped>
.home {
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px;
}
.hero {
  padding: 88px 0 56px;
}
h1 {
  margin: 0;
  max-width: 820px;
  font-size: 60px;
  line-height: 1.05;
  letter-spacing: -0.035em;
  font-weight: 600;
  color: var(--vp-c-text-1);
}
.lede {
  margin: 22px 0 0;
  max-width: 620px;
  font-size: 19px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 36px;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 44px;
  padding: 0 20px;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 500;
  text-decoration: none;
  transition: background-color 0.2s, border-color 0.2s;
}
.btn-primary {
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
}
.btn-primary:hover {
  background: var(--vp-button-brand-hover-bg);
}
.btn-alt {
  border: 1px solid var(--vp-c-border);
  color: var(--vp-c-text-1);
}
.btn-alt:hover {
  background: var(--vp-c-bg-soft);
}
.vendordep {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 4px 0 14px;
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  color: var(--vp-c-text-2);
  min-width: 0;
}
.vendordep-label {
  color: var(--vp-c-text-3);
}
.vendordep code {
  font-family: var(--vp-font-family-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vendordep button {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vp-c-text-3);
}
.vendordep button:hover {
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg);
}
.shot {
  padding: 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-c-bg-alt);
}
.shot img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
}
.section {
  padding-top: 96px;
}
.eyebrow {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}
h2 {
  margin: 10px 0 32px;
  font-size: 32px;
  line-height: 1.2;
  letter-spacing: -0.025em;
  font-weight: 600;
  color: var(--vp-c-text-1);
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 24px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: border-color 0.2s;
}
.card:hover {
  border-color: var(--vp-c-brand-soft-border);
}
.card svg {
  color: var(--vp-c-brand-1);
}
.card-title {
  font-size: 16px;
  font-weight: 600;
}
.card-text {
  font-size: 14px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}
.card-cta {
  margin-top: 4px;
  font-size: 14px;
  color: var(--vp-c-brand-1);
}
.features {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 40px;
}
.feature {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-decoration: none;
}
.feature-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}
.feature:hover .feature-title {
  color: var(--vp-c-brand-1);
}
.feature-text {
  font-size: 14px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.code-section {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 48px;
}
.code-copy {
  flex: 1 1 320px;
  min-width: 0;
}
.code-copy h2 {
  margin-bottom: 14px;
}
.code-copy p:not(.eyebrow) {
  margin: 0;
  font-size: 16px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.code-copy a {
  display: inline-block;
  margin-top: 18px;
  font-size: 15px;
  font-weight: 500;
  color: var(--vp-c-brand-1);
  text-decoration: none;
}
.code {
  flex: 1.4 1 460px;
  min-width: 0;
  border-radius: 14px;
  background: var(--vp-code-block-bg);
  overflow: hidden;
}
.code-title {
  padding: 12px 16px;
  border-bottom: 1px solid var(--vp-code-block-divider-color);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-code-lang-color);
}
.code pre {
  margin: 0;
  padding: 20px;
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.75;
  color: var(--vp-code-block-color);
}
.code .t {
  color: #c4b1ff;
}
.code .s {
  color: #9be2b9;
}
.code .n {
  color: #ffc98a;
}
.foot {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 16px;
  margin-top: 120px;
  padding: 32px 0 48px;
  border-top: 1px solid var(--vp-c-divider);
  font-size: 13px;
  color: var(--vp-c-text-3);
}
.foot-links {
  display: flex;
  gap: 20px;
}
.foot-links a {
  color: var(--vp-c-text-3);
  text-decoration: none;
}
.foot-links a:hover {
  color: var(--vp-c-text-1);
}
@media (max-width: 640px) {
  .hero {
    padding-top: 56px;
  }
  h1 {
    font-size: 40px;
  }
  .lede {
    font-size: 17px;
  }
  .vendordep {
    width: 100%;
  }
}
</style>
