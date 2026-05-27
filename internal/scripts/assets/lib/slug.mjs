export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[>_\s]+/g, '-')
    .replace(/[^\w가-힣\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function sectionSlug(name) {
  return slugify(name);
}
