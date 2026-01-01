<script lang="ts">
// Mock data
const _users = [
  { id: '1', email: 'alice@example.com' },
  { id: '2', email: 'bob@example.com' },
  { id: '3', email: 'carol@example.com' },
];

const _profiles = [
  { id: '1', name: 'Alice Johnson' },
  { id: '2', name: 'Bob Smith' },
  { id: '3', name: 'Carol Williams' },
];

const _selectedId = $state<string | null>(null);
</script>

<h1>UserCard</h1>
<p class="description">Displays a user card with avatar, name, email, role, and status.</p>

<section>
  <h2>Basic</h2>
  <div class="demo-col">
    <UserCard user={users[0]} profile={profiles[0]} />
  </div>
</section>

<section>
  <h2>With Role and Status</h2>
  <div class="demo-col">
    <UserCard user={users[0]} profile={profiles[0]} role="admin" status="active" />
    <UserCard user={users[1]} profile={profiles[1]} role="member" status="pending" />
    <UserCard user={users[2]} profile={profiles[2]} role="viewer" status="suspended" />
  </div>
</section>

<section>
  <h2>Clickable with Selection</h2>
  <p class="note">Selected: {selectedId ?? 'none'}</p>
  <div class="demo-col">
    {#each users as user, i}
      <UserCard
        {user}
        profile={profiles[i]}
        role="member"
        status="active"
        selected={selectedId === user.id}
        onclick={() => selectedId = user.id}
      />
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
        <td><code>user</code></td>
        <td><code>User</code></td>
        <td>required</td>
        <td>User object with email</td>
      </tr>
      <tr>
        <td><code>profile</code></td>
        <td><code>Profile</code></td>
        <td>required</td>
        <td>Profile object with name</td>
      </tr>
      <tr>
        <td><code>role</code></td>
        <td><code>string</code></td>
        <td>-</td>
        <td>Optional role label</td>
      </tr>
      <tr>
        <td><code>status</code></td>
        <td><code>string</code></td>
        <td>-</td>
        <td>Status: active, pending, suspended, deactivated</td>
      </tr>
      <tr>
        <td><code>onclick</code></td>
        <td><code>() => void</code></td>
        <td>-</td>
        <td>Click handler (makes card clickable)</td>
      </tr>
      <tr>
        <td><code>selected</code></td>
        <td><code>boolean</code></td>
        <td><code>false</code></td>
        <td>Show selected state</td>
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

  .demo-col {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 400px;
  }

  .note {
    font-size: 0.875rem;
    color: #666;
    margin-bottom: 12px;
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
