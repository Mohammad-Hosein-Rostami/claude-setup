// Advice (a quality rule, never an ask) for removing a container without its anonymous volumes: `docker rm -f x` keeps every anonymous
// volume the container made, and test databases removed that way filled 108 GB of the owner's disk (fixes spec rev 2, P12). The hook
// denies the first send with the fix and runs the identical retry (lib/bounce-once.mjs adviceOnce); lib/reason-classes.mjs matches the text exactly.
// Exports: DOCKER_RM_ADVICE, dockerRmAdvice(cmd, args) -> advice | undefined.
// Read: `docker|podman|nerdctl rm ...` and `... container rm ...` right after the command word (global options before `rm` are not read:
// no advice then). Volumes go with `-v`, `--volumes`, `--volumes=true` or a short-flag cluster holding v (`-fv`). Pure, no I/O.

export const DOCKER_RM_ADVICE = 'Disk space: docker rm without -v leaves the container\'s anonymous volumes on disk (they reached 108 GB). '
  + 'Add -v (docker rm -fv <name>), or start throwaway containers with --rm. If the volumes must stay, send the same command again and it runs.';

const CONTAINER_TOOLS = new Set(['docker', 'podman', 'nerdctl']);
const VOLUMES_FLAG = /^(?:-[A-Za-z]*v[A-Za-z]*|--volumes(?:=true)?)$/;
const END_OF_OPTIONS = '--';

/** The words after `rm` of a container removal, or undefined when the command is no `<tool> rm` / `<tool> container rm`. */
function removalArgs(cmd, args) {
  if (!CONTAINER_TOOLS.has(cmd)) return undefined;
  if (args[0] === 'rm') return args.slice(1);
  return args[0] === 'container' && args[1] === 'rm' ? args.slice(2) : undefined;
}

/**
 * @param {string} cmd the command word as the guard names it
 * @param {string[]} args its words after the command word
 * @returns {string | undefined} DOCKER_RM_ADVICE for a container removal that keeps its anonymous volumes, else undefined
 */
export function dockerRmAdvice(cmd, args) {
  const rest = removalArgs(cmd, args);
  if (rest === undefined) return undefined;
  const options = rest.includes(END_OF_OPTIONS) ? rest.slice(0, rest.indexOf(END_OF_OPTIONS)) : rest;
  return options.some((word) => VOLUMES_FLAG.test(word)) ? undefined : DOCKER_RM_ADVICE;
}
