<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const { siteConfig } = data;
</script>

<svelte:head>
  <title>About - {siteConfig.name}</title>
  <meta name="description" content="About {siteConfig.name}" />
</svelte:head>

<div class="about">
  <h1>About {siteConfig.name}</h1>

  <section>
    <h2>Our Mission</h2>
    <p>
      {siteConfig.name} provides timely, accurate, and comprehensive coverage of local government,
      community events, and news for {siteConfig.location.name} and surrounding areas.
    </p>
  </section>

  <section>
    <h2>What We Cover</h2>
    <ul>
      <li><strong>Local Government</strong> - Council meetings, decisions, and policy changes</li>
      <li><strong>County News</strong> - Regional government coverage</li>
      <li><strong>Weather</strong> - Local forecasts from Environment Canada</li>
      <li><strong>Community Events</strong> - Local happenings and announcements</li>
    </ul>
  </section>

  <section>
    <h2>How It Works</h2>
    <p>
      Our coverage is powered by AI-assisted journalism that processes official government documents
      to create clear, accessible summaries of council meetings and decisions. This helps residents
      stay informed about matters that affect their daily lives.
    </p>
  </section>

  <section>
    <h2>Contact</h2>
    <p>
      Have questions, feedback, or a tip? <a href="/contact">Contact us</a>.
    </p>
  </section>
</div>

<style>
  .about {
    max-width: 700px;
  }

  h1 {
    font-size: var(--font-size-2xl);
    margin-bottom: var(--spacing-xl);
    color: var(--color-neutral-gray900);
  }

  section {
    margin-bottom: var(--spacing-xl);
  }

  h2 {
    font-size: var(--font-size-lg);
    margin-bottom: var(--spacing-md);
    color: var(--color-neutral-gray800);
  }

  p {
    line-height: 1.7;
    color: var(--color-neutral-gray700);
    margin-bottom: var(--spacing-md);
  }

  ul {
    list-style: disc;
    padding-left: var(--spacing-lg);
    color: var(--color-neutral-gray700);
  }

  li {
    margin-bottom: var(--spacing-sm);
    line-height: 1.6;
  }

  a {
    color: var(--color-primary);
  }
</style>
