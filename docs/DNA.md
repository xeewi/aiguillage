# Aiguillage — ADN du projet

## En une phrase
Un chef d'orchestre **100 % local** pour faire tourner plusieurs agents Claude Code en parallèle, chacun dans son propre git worktree, depuis une seule fenêtre. Sans compte, sans cloud, sans télémétrie.

## Pourquoi
Un agent = une branche isolée, et on en pilote 5 à la fois. Aiguillage offre cette boucle de travail sans compte, sans app propriétaire ni service distant : sur ta machine uniquement.

## Les 5 gènes (non négociables)
1. **Local d'abord** : serveur sur `127.0.0.1`, état dans `~/.aiguillage/`, aucune requête réseau à part celles du CLI `claude` que tu utilises déjà. Aucune dépendance chargée depuis un CDN.
2. **Un workspace = un worktree = une branche** : chaque agent travaille isolé (`~/.aiguillage/worktrees/<repo>/<nom>`, branche `aig/<nom>`). Le repo principal n'est jamais modifié.
3. **On pilote le vrai `claude`** : on lance le CLI officiel en mode `stream-json`. L'authentification, les modèles, les MCP, les hooks et les skills restent ceux de l'utilisateur. Les sessions reprennent avec `--resume`.
4. **Relire avant de fusionner** : le diff contre la branche de base est toujours à un clic, et le terminal du worktree aussi.
5. **Simple à lire** : Node + JS vanilla, aucune étape de build pour développer (seul le `.dmg` passe par `electron-builder`), une poignée de fichiers. N'importe qui peut lire le code en une soirée.

L'app de bureau (`electron/main.js`) n'est qu'une fenêtre autour du même serveur : les utilisateurs attendent une vraie app, et Electron fait tourner `server.js` tel quel.

## Boucle utilisateur
1. Ajouter un repo local.
2. `+ Workspace` → worktree + branche créés, script `setup` lancé.
3. Discuter avec l'agent (streaming, outils affichés, interruption possible).
4. Relire l'onglet **Diff**, tester dans l'onglet **Terminal** ou avec **Run**.
5. **PR** (via `gh`, si présent) ou **Merge local** dans la branche de base.
6. **Archiver** → worktree supprimé, branche conservée.

## Configuration par repo
Scripts `setup` / `run` / `archive` dans `.aiguillage/settings*.toml` (ou `aiguillage.json`), fichiers ignorés à copier via `.worktreeinclude`, variables `AIGUILLAGE_*`. Voir README.

## Non-objectifs
- Comptes, synchronisation, cloud, collaboration multi-utilisateur.
- Réimplémenter Claude Code (pas d'appel direct à l'API).

## Anti-objectifs (échec même si « ça marche »)
- Un agent qui écrit dans le repo principal ou dans le worktree d'un autre. (Les outils d'édition sont bloqués hors du worktree ; une commande shell reste techniquement libre.)
- Perdre l'historique d'une conversation après un redémarrage.
- Exposer le serveur sur le réseau (écoute sur `127.0.0.1` uniquement).
