/**
 * Svelte action that shows/hides an element based on permissions
 *
 * Usage:
 * <button use:permission={{ slug: 'articles.edit', permissions: userPermissions }}>
 *   Edit
 * </button>
 */

interface PermissionParams {
  /** Permission slug to check */
  slug: string;
  /** User's current permissions */
  permissions: string[];
  /** If true, hide instead of removing from DOM */
  hideOnly?: boolean;
}

export function permission(
  node: HTMLElement,
  params: PermissionParams,
): { update: (params: PermissionParams) => void; destroy: () => void } {
  const originalDisplay = node.style.display;

  function update(params: PermissionParams) {
    const hasPermission = params.permissions.includes(params.slug);

    if (hasPermission) {
      node.style.display = originalDisplay;
      node.removeAttribute('aria-hidden');
    } else if (params.hideOnly) {
      node.style.display = 'none';
      node.setAttribute('aria-hidden', 'true');
    } else {
      node.style.display = 'none';
      node.setAttribute('aria-hidden', 'true');
    }
  }

  update(params);

  return {
    update,
    destroy() {
      // Restore original display on unmount
      node.style.display = originalDisplay;
    },
  };
}

/**
 * Check if user has a specific permission
 */
export function hasPermission(permissions: string[], slug: string): boolean {
  return permissions.includes(slug);
}

/**
 * Check if user has all specified permissions
 */
export function hasAllPermissions(
  permissions: string[],
  slugs: string[],
): boolean {
  return slugs.every((slug) => permissions.includes(slug));
}

/**
 * Check if user has any of the specified permissions
 */
export function hasAnyPermission(
  permissions: string[],
  slugs: string[],
): boolean {
  return slugs.some((slug) => permissions.includes(slug));
}
