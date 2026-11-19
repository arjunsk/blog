const markerNames = new WeakMap();
let diagramCount = 0;

export function installArrowDefs(svg) {
  const diagram = svg.node();
  let names = markerNames.get(diagram);
  if (!names) {
    const id = `innodb-arrows-${++diagramCount}`;
    names = { flow: `${id}-flow`, undo: `${id}-undo` };
    markerNames.set(diagram, names);
  }

  const defs = svg.insert('defs', ':first-child');
  for (const [name, color] of [[names.flow, 'var(--accent)'], [names.undo, 'var(--accent-2)']]) {
    defs.append('marker')
      .attr('id', name).attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M0,0 L10,5 L0,10 z').attr('fill', color);
  }

  return { flow: `url(#${names.flow})`, undo: `url(#${names.undo})` };
}
