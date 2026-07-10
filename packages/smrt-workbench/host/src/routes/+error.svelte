<script lang="ts">
import { page } from '$app/state';
</script>

<main class="workbench-error" data-testid="workbench-error">
  <p>Workbench Error</p>
  <h1>{page.status}</h1>
  <pre>{page.error?.message ?? 'Unknown error'}</pre>
</main>

<style>
  .workbench-error {
    box-sizing: border-box;
    min-height: 100vh;
    padding: 2rem;
    font-family: system-ui, sans-serif;
    background: #f5f7fb;
    color: #121926;
  }

  p {
    margin: 0 0 0.5rem;
    color: #5f6b7a;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0 0 1rem;
    font-size: 2rem;
  }

  pre {
    max-width: 70rem;
    overflow: auto;
    padding: 1rem;
    border: 1px solid #cfd7e3;
    border-radius: 0.5rem;
    background: #ffffff;
    white-space: pre-wrap;
  }
</style>
