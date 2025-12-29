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
  // Save original styles for restoration
  const originalStyles = {
    display: node.style.display,
    visibility: node.style.visibility,
    position: node.style.position,
    pointerEvents: node.style.pointerEvents,
  };

  function update(params: PermissionParams) {
    const hasPermission = params.permissions.includes(params.slug);

    if (hasPermission) {
      // Restore original styles
      node.style.display = originalStyles.display;
      node.style.visibility = originalStyles.visibility;
      node.style.position = originalStyles.position;
      node.style.pointerEvents = originalStyles.pointerEvents;
      node.removeAttribute('aria-hidden');
    } else if (params.hideOnly) {
      // Hide only: make invisible but keep in DOM layout
      node.style.display = 'none';
      node.setAttribute('aria-hidden', 'true');
    } else {
      // Default: remove from layout flow completely
      node.style.display = 'none';
      node.style.visibility = 'hidden';
      node.style.position = 'absolute';
      node.style.pointerEvents = 'none';
      node.setAttribute('aria-hidden', 'true');
    }
  }

  update(params);

  return {
    update,
    destroy() {
      // Restore original styles on unmount
      node.style.display = originalStyles.display;
      node.style.visibility = originalStyles.visibility;
      node.style.position = originalStyles.position;
      node.style.pointerEvents = originalStyles.pointerEvents;
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
