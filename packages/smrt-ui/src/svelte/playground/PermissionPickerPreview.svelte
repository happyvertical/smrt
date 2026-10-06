<script lang="ts">
import PermissionPicker from '../../components/permissions/PermissionPicker.svelte';

const permissions = [
  { slug: 'projects.read', name: 'View projects', category: 'Projects' },
  { slug: 'projects.update', name: 'Update projects', category: 'Projects' },
  {
    slug: 'tenant.settings.read',
    name: 'View workspace settings',
    description: 'Review the active workspace configuration.',
    category: 'Workspace',
  },
  {
    slug: 'tenant.settings.manage',
    name: 'Manage workspace settings',
    category: 'Workspace',
  },
];
</script>

<form>
  <PermissionPicker
    {permissions}
    selected={['projects.read', 'tenant.settings.read']}
    description="Choose the capabilities assigned to this role."
  />
</form>
