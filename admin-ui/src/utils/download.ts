/**
 * Triggers a browser "Save As" for in-memory text content, without ever touching
 * the network. Factored out of the near-identical Blob -> object URL -> anchor
 * click -> revoke sequence duplicated in AuditLogPage.vue and ConfigPage.vue.
 */
export function downloadTextFile(filename: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
