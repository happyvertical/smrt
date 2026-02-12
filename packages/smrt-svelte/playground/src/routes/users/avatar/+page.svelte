<script lang="ts">
import { UserAvatar } from '@happyvertical/smrt-users/svelte';

// Mock profiles
const profiles = [
  { id: '1', name: 'Alice Johnson' },
  { id: '2', name: 'Bob Smith' },
  { id: '3', name: 'Carol Williams' },
  { id: '4', name: 'David Brown' },
  { id: '5', name: 'Eve Davis' },
];

const sizes = ['sm', 'md', 'lg', 'xl'] as const;
</script>

<h1>UserAvatar</h1>
<p class="description">Displays a user avatar with color-coded initials based on the user's name.</p>

<section>
  <h2>Sizes</h2>
  <div class="demo-row">
    {#each sizes as size}
      <div class="demo-item">
        <UserAvatar profile={profiles[0]} {size} />
        <span class="label">{size}</span>
      </div>
    {/each}
  </div>
</section>

<section>
  <h2>Different Users (Color Variation)</h2>
  <div class="demo-row">
    {#each profiles as profile}
      <UserAvatar {profile} size="lg" />
    {/each}
  </div>
</section>

<section>
  <h2>With Name</h2>
  <div class="demo-col">
    {#each profiles.slice(0, 3) as profile}
      <UserAvatar {profile} size="md" showName />
    {/each}
  </div>
</section>

<section>
  <h2>Props</h2>
  <table class="props-table">
    <thead>
      <tr>
        <th>Prop</th>
        <th>Type</th>
        <th>Default</th>
        <th>Description</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><code>profile</code></td>
        <td><code>Profile</code></td>
        <td>required</td>
        <td>The user's profile object with name</td>
      </tr>
      <tr>
        <td><code>size</code></td>
        <td><code>'sm' | 'md' | 'lg' | 'xl'</code></td>
        <td><code>'md'</code></td>
        <td>Avatar size</td>
      </tr>
      <tr>
        <td><code>showName</code></td>
        <td><code>boolean</code></td>
        <td><code>false</code></td>
        <td>Show name next to avatar</td>
      </tr>
    </tbody>
  </table>
</section>

<style>
  h1 {
    font-size: 1.75rem;
    margin-bottom: 8px;
  }

  .description {
    color: #666;
    margin-bottom: 32px;
  }

  section {
    margin-bottom: 40px;
  }

  h2 {
    font-size: 1rem;
    color: #333;
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid #eee;
  }

  .demo-row {
    display: flex;
    align-items: center;
    gap: 24px;
    flex-wrap: wrap;
  }

  .demo-col {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .demo-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .label {
    font-size: 0.75rem;
    color: #888;
  }

  .props-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  .props-table th,
  .props-table td {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid #eee;
  }

  .props-table th {
    background: #f9f9f9;
    font-weight: 500;
  }

  code {
    background: #f3f4f6;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.8rem;
  }
</style>
