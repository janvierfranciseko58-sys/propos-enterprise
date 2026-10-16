// Rattachement automatique d'un bulletin PDF à un salarié d'après le nom du fichier
export function nameTokens(s) {
  return (s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2);
}
// Un fichier n'est rattaché que si TOUS les mots du nom (prénom + nom) y figurent,
// et seulement s'il n'y a qu'un seul salarié possible. Sinon : « À vérifier ».
export function matchEmployeeToFile(filename, employees) {
  const fileTokens = new Set(nameTokens(filename.replace(/\.pdf$/i, "")));
  const candidates = employees.filter(e => {
    const tokens = nameTokens(e.full_name);
    return tokens.length >= 2 && tokens.every(t => fileTokens.has(t));
  });
  if (!candidates.length) return null;
  const maxTokens = Math.max(...candidates.map(e => nameTokens(e.full_name).length));
  const best = candidates.filter(e => nameTokens(e.full_name).length === maxTokens);
  return best.length === 1 ? best[0] : null;
}
