<script setup lang="ts">
import { ref } from "vue";
import { withBase } from "vitepress";

const repo = "https://github.com/ryanabraham1/Mayhem";
const vendordep = "https://ryanabraham1.github.io/Mayhem/MayhemCpp.json";
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
    title: "Using Mayhem",
    text: "Every workspace: autos, state machines, logs, the robot, and reviewing code changes.",
    cta: "Tour the app",
    link: "/suite/overview",
    icon: "M3 4h18v14H3zM8 21h8M12 18v3",
  },
  {
    title: "Robot code",
    text: "Install the C++ library, run your autos and state machines, and log what Mayhem reads.",
    cta: "Set up a robot repo",
    link: "/robot-code/setup",
    icon: "M5 8h14v11H5zM12 4v4M9 13h.01M15 13h.01M3 13v2M21 13v2",
  },
  {
    title: "Agents",
    text: "Tell a coding agent what you want in its chat. Review what it changed here, by behavior.",
    cta: "Connect an agent",
    link: "/agents/",
    icon: "M12 8V4H8M4 12h16v8H4zM2 16h2M20 16h2M9 15v1M15 15v1",
  },
];

const features = [
  ["Pose-based autos", "Place goals, draw routes, add actions and conditions, and preview with simulated inputs.", "/suite/autonomous"],
  ["Review by behavior", "See what a code change does to controls, values, hardware and autos, with a before/after sim proof.", "/suite/changes"],
  ["Branches to review", "Every branch that isn't in main yet, with its risk, its recorded sim proof, and how far it has got.", "/suite/changes#branches-to-review"],
  ["On the robot now", "What's deployed, how it differs from main, every value in the code, and one-click rollback.", "/suite/robot#on-the-robot-now"],
  ["Log analysis", "Findings, power, signals and pose playback, with automatic collection and team upload.", "/suite/logs"],
  ["State machines", "Routine and mechanism graphs in simulation, live over NT4, or from a recording.", "/suite/state-machines"],
];

const shots = [
  ["autonomous", "Autonomous", "Autonomous workspace editing a routine on the 2026 field"],
  ["state-machines", "State machines", "An autonomous routine drawn as a state graph"],
  ["logs", "Logs", "A match log with battery and current findings"],
  ["changes-autos", "Changes", "Before and after paths of an auto, colored by speed"],
];
</script>

<template>
  <div class="home">
    <section class="hero">
      <h1>Autos, logs and code reviews in one app.</h1>
      <p class="lede">
        Build pose-based routines, see what's running on the robot, analyze match logs, review what a code change does,
        and hand work to coding agents.
      </p>
      <div class="actions">
        <a class="btn btn-primary" :href="withBase('/guide/introduction')">Get started</a>
        <a class="btn btn-alt" :href="`${repo}/releases/latest`" target="_blank" rel="noreferrer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /></svg>
          Download the app
        </a>
        <div class="vendordep">
          <span class="vendordep-label">C++ vendordep</span>
          <code>{{ vendordep.replace("https://", "") }}</code>
          <button type="button" :aria-label="copied ? 'Copied' : 'Copy vendordep URL'" @click="copyVendordep">
            <svg v-if="!copied" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7" /></svg>
          </button>
        </div>
      </div>
    </section>

    <section class="shot">
      <img :src="withBase('/img/suite/overview.jpg')" alt="Mayhem's Overview: the team's autonomous routines, feedback for agents and the match-ready checklist" />
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

    <section class="section">
      <p class="eyebrow">The workspaces</p>
      <h2>See it before you install it</h2>
      <div class="gallery">
        <a v-for="[file, title, alt] in shots" :key="file" class="gallery-item" :href="withBase(`/img/suite/${file}.jpg`)" target="_blank">
          <img :src="withBase(`/img/suite/${file}.jpg`)" :alt="alt" loading="lazy" />
          <span>{{ title }}</span>
        </a>
      </div>
    </section>

    <section class="section code-section">
      <div class="code-copy">
        <p class="eyebrow">Robot code · C++</p>
        <h2>The app's IDs, bound in robot code</h2>
        <p>Actions and conditions you name in an auto become bindings on the runner. Anything left unbound is an error at boot, not a failed step mid-match.</p>
        <a :href="withBase('/robot-code/autos')">Running autos →</a>
      </div>
      <div class="code">
        <div class="code-title">MayhemAutos.cpp</div>
        <pre><code><span class="t">mayhem::AutoRunner</span> runner{routine.View()};
runner.Bind(<span class="s">"superstructure.intake"</span>,
            <span class="t">mayhem::Instant</span>([&amp;] { intake.Start(); }))
      .BindSignal(<span class="s">"superstructure.ready"</span>,
            [&amp;] { <span class="k">return</span> <span class="t">mayhem::SignalValue</span>{shooter.Ready()}; });

<span class="k">if</span> (<span class="k">auto</span> missing = runner.UnboundReport(); !missing.empty())
  alert.SetText(<span class="s">"Unhandled Mayhem IDs: "</span> + missing);</code></pre>
      </div>
    </section>

    <footer class="foot">
      <span>Mayhem is an open-source FRC project. Not affiliated with FIRST or WPILib.</span>
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
.code .k {
  color: #ff9cc2;
}
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}
.gallery-item {
  display: flex;
  flex-direction: column;
  gap: 10px;
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1);
}
.gallery-item img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 10;
  object-fit: cover;
  object-position: top left;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  transition: border-color 0.2s;
}
.gallery-item:hover img {
  border-color: var(--vp-c-brand-soft-border);
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
