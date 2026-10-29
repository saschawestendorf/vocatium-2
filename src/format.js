// Formatierungs-Hilfsfunktionen (HTML-Escaping, Euro-Beträge).
export const escapeHtml = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const formatEuro = (n) => `${new Intl.NumberFormat('de-DE').format(n)} €`;
