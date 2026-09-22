import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, renderDefinitions, renderSemanticSigil, textUnits } from '../shared/utils.mjs';
import {
  animateAttr,
  focusEdgeAttrs,
  focusNodeAttrs,
  focusNodeTitle,
  loadDiagram,
  svgAccessibleText,
  svgRootAttrs,
  writeDiagram,
} from '../shared/cli.mjs';
import { throwDiagnosticProblems } from '../shared/diagnostics.mjs';
import {
  legendFootprint,
  relationshipLegendObstacles,
  resolveLegend,
  renderLegend as renderResolvedLegend,
} from '../shared/legend.mjs';
import { nodeTextFit, fittedNodeFontSize } from '../shared/text-fit.mjs';
import { translateMessage as i18nText } from '../shared/i18n.mjs';
import {
  DEFAULT_ER_GRID,
  bandedLayout,
  entityHeight,
  erGridLayout,
  resolveEntityPos,
  resolvedEntityWidth,
  validateErGridPlacement,
} from './grid.mjs';
import {
  asArray,
  arrowClassMap,
  cleanAmbiguousCorridorProblems,
  cleanCrossingProblems,
  cleanEndpointSideProblems,
  cleanFlowProblems,
  cleanLabelRouteClearanceProblems,
  cleanRouteRhythmProblems,
  componentFill,
  componentText,
  labelPoint,
  legacyDefaultFromSide,
  legacyDefaultToSide,
  rectsOverlap,
  roundedPath,
  routePointsValue,
  segmentIntersectsRect,
  suggestComponentSeparation,
  suggestLabelObstacleFix,
  variantAccent,
} from '../shared/geometry.mjs';
import { createRouter } from '../shared/orthogonal-router.mjs';
import { entityBox, connectionPath as relationshipPath } from '../shared/layout-report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const layoutJsonMode = process.argv.includes('--layout-json');
const cliArgs = process.argv.filter((arg) => arg !== '--layout-json');
const { diagram: er, template, outPath, sourceEvidence } = loadDiagram({
  rendererDir: __dirname,
  diagramType: 'erd',
  defaultExample: 'orders.erd.json',
  argv: cliArgs,
});

const grid = erGridLayout(er);

const layout = {
  margin: 24,
  legendH: 32,
  padX: 12,
  keyWidth: 28,
  keyFont: 8,
  headerFont: 12,
  headerFontMinimum: 9,
  rowFont: 10,
  rowFontMinimum: 8,
  typeFont: 9,
  typeFontMinimum: 8,
  detailPreferred: 9,
  detailMinimum: 7,
  minRelationshipLength: 24,
};

const ENTITY_FILL = componentFill.database;
const ENTITY_ACCENT = componentText.database;
const KEY_ACCENT = { pk: 't-database', fk: 't-messagebus', uk: 't-muted' };

// ---- Measure entities from the banded grid -----------------------------------
// Header and row metrics live in the grid contract so the banded layout and the
// renderer can never disagree about a box's height.
const metrics = grid ?? DEFAULT_ER_GRID;

// Width resolution lives in the grid module so placement and measurement cannot
// disagree about an entity that omits `width`.
const entityWidth = (entity) => resolvedEntityWidth(entity, grid);

const measuredEntities = asArray(er.entities).map((entity) => {
  const attributes = asArray(entity.attributes);
  const width = entityWidth(entity);
  return {
    ...entity,
    attributes,
    width,
    height: entityHeight({ ...entity, attributes }, grid ?? DEFAULT_ER_GRID),
  };
});

const bands = grid ? bandedLayout(measuredEntities, grid) : null;

const entities = new Map(measuredEntities.map((entity) => {
  const [x, y] = resolveEntityPos(entity, grid, bands);
  return [entity.id, { ...entity, x, y, cx: x + entity.width / 2, cy: y + entity.height / 2 }];
}));

const relationships = asArray(er.relationships);

// ---- Domain bands ------------------------------------------------------------
// A `tag` names a domain, and a domain has to read as one block. The band is
// measured from the placed boxes of the entities that carry the tag, so it
// follows the authored grid instead of introducing a second layout pass. Only a
// run that is genuinely contiguous (one row with adjacent columns, or one column
// with adjacent rows) earns a band: a tag whose members are spread across the
// canvas is a grouping the author did not actually make, and drawing a band
// around the gap would claim a structure the table placement contradicts. A
// single-member or scattered tag still shows in its table's header note.
const DOMAIN_PAD_X = 12;
const DOMAIN_PAD_TOP = 18;
const DOMAIN_PAD_BOTTOM = 8;

function gridRunIsContiguous(members) {
  const cols = [...new Set(members.map((entity) => entity.col))].sort((a, b) => a - b);
  const rows = [...new Set(members.map((entity) => entity.row))].sort((a, b) => a - b);
  const adjacent = (values) => values.every((value, index) => index === 0 || value === values[index - 1] + 1);
  if (rows.length === 1) return adjacent(cols);
  if (cols.length === 1) return adjacent(rows);
  return false;
}

const domainGroups = (() => {
  const byTag = new Map();
  for (const entity of entities.values()) {
    if (!entity.tag) continue;
    if (!byTag.has(entity.tag)) byTag.set(entity.tag, []);
    byTag.get(entity.tag).push(entity);
  }
  const groups = [];
  for (const [tag, members] of byTag) {
    if (members.length < 2) continue;
    if (!members.every((entity) => Number.isInteger(entity.row) && Number.isInteger(entity.col))) continue;
    if (!gridRunIsContiguous(members)) continue;
    groups.push({ tag, members });
  }
  return groups;
})();

const bandedEntityIds = new Set(domainGroups.flatMap((group) => group.members.map((entity) => entity.id)));

function renderDomainBands() {
  if (!domainGroups.length) return '';
  return domainGroups.map(({ tag, members }) => {
    const minX = Math.min(...members.map((entity) => entity.x));
    const minY = Math.min(...members.map((entity) => entity.y));
    const maxX = Math.max(...members.map((entity) => entity.x + entity.width));
    const maxY = Math.max(...members.map((entity) => entity.y + entity.height));
    const x = minX - DOMAIN_PAD_X;
    const y = minY - DOMAIN_PAD_TOP;
    const width = maxX - minX + DOMAIN_PAD_X * 2;
    const height = maxY - minY + DOMAIN_PAD_TOP + DOMAIN_PAD_BOTTOM;
    return `        <g data-domain-band="${esc(tag)}">
          <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" class="c-lane" stroke-width="1"/>
          <text data-domain-label="" x="${x + 10}" y="${y + 13}" class="t-muted" font-size="9" font-weight="700">${esc(tag)}</text>
        </g>`;
  }).join('\n');
}

const entitySteps = new Map();
for (const [index, relationship] of relationships.entries()) {
  if (!entitySteps.has(relationship.from)) entitySteps.set(relationship.from, index);
  if (!entitySteps.has(relationship.to)) entitySteps.set(relationship.to, index + 1);
}
for (const [index, entity] of asArray(er.entities).entries()) {
  if (!entitySteps.has(entity.id)) entitySteps.set(entity.id, index);
}

// ---- Cardinality -------------------------------------------------------------
// A relationship reads `from` -> `to` and both ends declare their own maximum.
// The schema requires each one, so an unstated maximum fails validation before
// rendering instead of reading as a fact the author never asserted; this
// fallback only keeps an already-invalid diagram from crashing the renderer.
function cardinalityOf(relationship, endpoint) {
  const value = endpoint === 'from' ? relationship.fromCardinality : relationship.toCardinality;
  if (value === 'one' || value === 'many') return value;
  return endpoint === 'from' ? 'many' : 'one';
}

function optionalOf(relationship, endpoint) {
  return (endpoint === 'from' ? relationship.fromOptional : relationship.toOptional) === true;
}

function markerStyleOf(relationship) {
  return (relationship.variant ?? (relationship.identifying === false ? 'dashed' : 'default'));
}

function cardinalityMarkerId(relationship, endpoint) {
  const cardinality = cardinalityOf(relationship, endpoint);
  const optional = optionalOf(relationship, endpoint) ? '-optional' : '';
  return `er-${cardinality}${optional}-${endpoint === 'from' ? 'start' : 'end'}`;
}

// Crow's foot notation: the symbol touches the entity, so the marker's vertex
// sits on the path endpoint and the toes spread back along the relationship.
// `start` markers are mirrored because an oriented marker's +x axis points
// along the path direction, which leaves the from-endpoint heading outward.
// The glyph is drawn in the muted text ink rather than the shared arrow token:
// at the light theme's arrow colour a crow's foot over a table fill sits near
// 2:1 contrast and reads as a smudge.
//
// The optionality ring sits past the toes rather than inside them. Both facts
// are about the same end, so a ring centred on the foot would be bisected by
// its middle toe and read as one muddy shape instead of "zero or many".
const MARKER_GLYPH_WIDTH = 24;
const MARKER_VERTEX_X = 22;
const MARKER_CIRCLE_X = 3.5;
function cardinalityMarkerMarkup(id, { cardinality, optional, mirror }) {
  const flip = (x) => (mirror ? MARKER_VERTEX_X - x : x);
  const parts = [];
  if (cardinality === 'many') {
    parts.push(`<path d="M ${flip(MARKER_VERTEX_X)} 8 L ${flip(8)} 1 M ${flip(MARKER_VERTEX_X)} 8 L ${flip(8)} 8 M ${flip(MARKER_VERTEX_X)} 8 L ${flip(8)} 15"/>`);
  } else {
    parts.push(`<path d="M ${flip(17)} 1 L ${flip(17)} 15"/>`);
  }
  if (optional) {
    // The ring sits on the relationship line, so the line has to be masked
    // under it: a stroked circle alone leaves the dashes running through the
    // middle and the symbol reads as a crossed-out dot.
    parts.push(`<circle cx="${flip(MARKER_CIRCLE_X)}" cy="8" r="2.6" class="c-mask"/>`);
    parts.push(`<circle cx="${flip(MARKER_CIRCLE_X)}" cy="8" r="2.6"/>`);
  }
  const refX = mirror ? 0 : MARKER_VERTEX_X;
  return `          <marker id="${esc(id)}" markerWidth="${MARKER_GLYPH_WIDTH}" markerHeight="18" refX="${refX}" refY="8" orient="auto" markerUnits="userSpaceOnUse" class="a-default" style="stroke: var(--text-muted)" stroke-width="1.75">
            ${parts.join('\n            ')}
          </marker>`;
}

function renderCardinalityDefs() {
  const used = new Set();
  for (const relationship of relationships) {
    used.add(`${cardinalityOf(relationship, 'from')}|${optionalOf(relationship, 'from')}|start`);
    used.add(`${cardinalityOf(relationship, 'to')}|${optionalOf(relationship, 'to')}|end`);
  }
  const ids = [];
  for (const cardinality of ['one', 'many']) {
    for (const optional of [false, true]) {
      for (const end of ['start', 'end']) {
        ids.push({ id: `er-${cardinality}${optional ? '-optional' : ''}-${end}`, cardinality, optional, mirror: end === 'start', key: `${cardinality}|${optional}|${end}` });
      }
    }
  }
  const markup = ids.filter((entry) => used.has(entry.key))
    .map((entry) => cardinalityMarkerMarkup(entry.id, entry));
  if (!markup.length) return '';
  return `\n          <!-- Cardinality symbols -->\n${markup.join('\n')}`;
}

// ---- Legend ------------------------------------------------------------------
const LEGEND_CATALOG = ['pk', 'fk', 'uk', 'one', 'many', 'optional']
  .map((kind) => ({ kind, label: i18nText(er.meta.locale, `legend.erd.${kind}`), swatchWidth: 18 }));

const presentKinds = new Set();
for (const entity of entities.values()) {
  for (const attribute of entity.attributes) {
    if (attribute.key) presentKinds.add(attribute.key);
  }
}
for (const relationship of relationships) {
  presentKinds.add(cardinalityOf(relationship, 'from'));
  presentKinds.add(cardinalityOf(relationship, 'to'));
  if (optionalOf(relationship, 'from') || optionalOf(relationship, 'to')) presentKinds.add('optional');
}
const erLegendEntries = resolveLegend(er.meta?.legend, LEGEND_CATALOG, presentKinds);

function autoViewBox() {
  const maxX = Math.max(0, ...[...entities.values()].map((entity) => entity.x + entity.width));
  const maxY = Math.max(0, ...[...entities.values()].map((entity) => entity.y + entity.height));
  let width = Math.ceil(maxX + layout.margin);
  let footprint = legendFootprint(erLegendEntries, { width: Math.max(1, width - layout.margin * 2) });
  if (footprint.minWidth > width - layout.margin * 2) {
    width = Math.ceil(footprint.minWidth + layout.margin * 2);
    footprint = legendFootprint(erLegendEntries, { width: width - layout.margin * 2 });
  }
  const height = Math.ceil(maxY + layout.margin + layout.legendH + footprint.extraHeight);
  return [width, height];
}

const viewBox = Array.isArray(er.meta?.viewBox) ? er.meta.viewBox : autoViewBox();
const legendY = () => viewBox[1] - 16;

// ---- Routing -----------------------------------------------------------------
// Relationships that would share one corridor get a deterministic lane each, so
// two routes never sit on the identical channel line. The lane is only a
// preference: a lane that breaks the endpoint contract or hits an entity is
// skipped and the shared candidate families run unchanged.
const LANE_STEP = 12;

// A cardinality glyph is 14 units tall, so two relationships leaving the same
// table side must sit at least this far apart: the shared 14px spread put them
// close enough to read as one shape. The trunk bridge below is derived from it.
const ERD_PORT_SPACING = 24;

const bandKey = (entity) => (
  Number.isInteger(entity.row) && Number.isInteger(entity.col)
    ? `i${entity.row},${entity.col}`
    : `p${Math.round(entity.x || 0)},${Math.round(entity.y || 0)}`
);

const { ports, pathFor, connectionSides, connectionEndpointSide } = createRouter(entities, relationships, {
  // Horizontal-first, like every other non-architecture type: a relationship
  // leaves and enters on the left/right when the tables sit side by side and
  // only falls back to a top/bottom port when they share a column. The shared
  // router defaults to architecture's dominant-axis inference, which would flip
  // the side of a relationship whose targets happen to sit further apart
  // vertically, splitting one fan-in into two groups nobody authored.
  sideFor: (relationship, endpoint) => {
    const from = entities.get(relationship.from);
    const to = entities.get(relationship.to);
    if (!from || !to) return undefined;
    return endpoint === 'source' ? legacyDefaultFromSide(from, to) : legacyDefaultToSide(from, to);
  },
  preferredCandidates: (context) => [...trunkCandidates(context), ...laneCandidates(context)],
  extraCandidates: (context) => [...detourCandidates(context), ...outsideCandidates(context)],
  // A cardinality glyph is 14 units tall, so ports must clear it (see
  // ERD_PORT_SPACING, which the trunk bridge is derived from).
  portSpacing: ERD_PORT_SPACING,
});

function corridorKey(relationship) {
  const from = entities.get(relationship.from);
  const to = entities.get(relationship.to);
  if (!from || !to) return null;
  const { fromSide, toSide } = connectionSides(relationship);
  const horizontalPorts = (fromSide === 'left' || fromSide === 'right');
  const verticalPorts = (fromSide === 'top' || fromSide === 'bottom');
  if (horizontalPorts === verticalPorts) return null;
  const ordered = horizontalPorts
    ? [from, to].sort((left, right) => left.cx - right.cx)
    : [from, to].sort((left, right) => left.cy - right.cy);
  return `${horizontalPorts ? 'h' : 'v'}:${bandKey(ordered[0])}|${bandKey(ordered[1])}`;
}

const laneOffsets = new Map();
{
  const groups = new Map();
  for (const relationship of relationships) {
    const key = corridorKey(relationship);
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(relationship);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((left, right) => {
      const leftKey = `${left.from}\u0000${left.to}\u0000${left.id || ''}`;
      const rightKey = `${right.from}\u0000${right.to}\u0000${right.id || ''}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    for (const [index, relationship] of list.entries()) {
      laneOffsets.set(relationship, index - (list.length - 1) / 2);
    }
  }
}

// ---- Bundled fan-in / fan-out trunks ------------------------------------------
// Relationships that share one entity side read better as a single trunk with
// short branches than as a sheaf of parallel lines (bus-style fan-in). A trunk
// group shares the resolved side, the marker style, and automatic routing;
// anything authored (route/via/labelAt) keeps its own line. The trunk is only
// a preferred candidate: a route that would break the endpoint contract or
// clip an entity falls back to the ordinary families and stays unbundled.
const TRUNK_OFFSETS = [16, 22, 12, 28];
const TRUNK_SNAP = LANE_STEP;
// One port step of uncovered bus is a bus with a gap in it: the branches were
// spread by ERD_PORT_SPACING, so the gap they leave is exactly that wide. Two
// steps means the runs belong to different groups and stay separate lines.
const TRUNK_BRIDGE = ERD_PORT_SPACING + 8;
const TRUNK_CAP = 10;
const TRUNK_LEG = 12;

const isHorizontalSide = (side) => (side === 'left' || side === 'right');

function relationshipAutoRouted(relationship) {
  return renderableRelationship(relationship)
    && !relationship.via
    && (!relationship.route || relationship.route === 'auto')
    && relationship.channelX === undefined
    && relationship.channelY === undefined
    && !relationship.labelAt;
}

function sideAnchor(entity, side) {
  if (side === 'left') return [entity.x, entity.cy];
  if (side === 'right') return [entity.x + entity.width, entity.cy];
  if (side === 'top') return [entity.cx, entity.y];
  return [entity.cx, entity.y + entity.height];
}

const trunkGroups = [];
const trunkAssignments = new Map();
{
  const fanIn = new Map();
  const fanOut = new Map();
  const resolvedSides = new Map();
  const push = (map, key, entry) => {
    const list = map.get(key) || [];
    list.push(entry);
    map.set(key, list);
  };
  for (const [index, relationship] of relationships.entries()) {
    if (!relationshipAutoRouted(relationship)) continue;
    const { fromSide, toSide } = connectionSides(relationship);
    resolvedSides.set(relationship, { fromSide, toSide });
    const styleKey = markerStyleOf(relationship);
    push(fanIn, `${relationship.to}\u0000${toSide}\u0000${styleKey}`, { index, relationship });
    push(fanOut, `${relationship.from}\u0000${fromSide}\u0000${styleKey}`, { index, relationship });
  }
  const taken = new Set();
  const buildGroups = (map, role) => {
    const grouped = [...map.values()]
      .filter((list) => list.length >= 2)
      .sort((left, right) => left[0].index - right[0].index);
    for (const list of grouped) {
      const members = list.filter((entry) => !taken.has(entry.relationship));
      if (members.length < 2) continue;
      const head = members[0].relationship;
      const sides = resolvedSides.get(head);
      const group = {
        role,
        entity: entities.get(role === 'in' ? head.to : head.from),
        side: role === 'in' ? sides.toSide : sides.fromSide,
        styleKey: markerStyleOf(head),
        members: members.map((entry) => entry.relationship),
      };
      for (const entry of members) {
        taken.add(entry.relationship);
        trunkAssignments.set(entry.relationship, { group });
      }
      trunkGroups.push(group);
    }
  };
  buildGroups(fanIn, 'in');
  buildGroups(fanOut, 'out');

  // One trunk coordinate per group, just outside the shared side. A coordinate
  // close to an already chosen trunk snaps onto it, so fan-in and fan-out
  // groups sharing one channel read as a single bus with drops on both sides.
  const chosenLines = [];
  for (const group of trunkGroups) {
    group.axis = isHorizontalSide(group.side) ? 0 : 1;
    const portAxis = group.axis === 0 ? 1 : 0;
    const coordinates = group.members.map((relationship) => {
      const port = ports.get(relationship)?.[group.role === 'in' ? 'to' : 'from'];
      return (port || sideAnchor(group.entity, group.side))[portAxis];
    });
    const low = Math.min(...coordinates) - TRUNK_CAP;
    const high = Math.max(...coordinates) + TRUNK_CAP;
    const clearsSpan = (coordinate) => {
      const segment = group.axis === 0
        ? { start: [coordinate, low], end: [coordinate, high] }
        : { start: [low, coordinate], end: [high, coordinate] };
      return [...entities.values()].every((entity) => !segmentIntersectsRect(segment, entity));
    };
    const base = isHorizontalSide(group.side)
      ? (group.side === 'left' ? group.entity.x : group.entity.x + group.entity.width)
      : (group.side === 'top' ? group.entity.y : group.entity.y + group.entity.height);
    const outward = group.side === 'left' || group.side === 'top' ? -1 : 1;
    for (const offset of TRUNK_OFFSETS) {
      const candidate = base + outward * offset;
      if (!clearsSpan(candidate)) continue;
      const near = chosenLines.find((line) => line.axis === group.axis
        && line.styleKey === group.styleKey
        && Math.abs(line.coordinate - candidate) < TRUNK_SNAP);
      // A snapped coordinate serves another group's span; it must clear this
      // one too, otherwise the next offset is tried.
      if (near && !clearsSpan(near.coordinate)) continue;
      // A differently styled trunk never shares a coordinate: the bus would
      // have to render in one group's dash language, so the next offset is
      // tried until the two lines are a lane apart.
      const clashing = chosenLines.some((line) => line.axis === group.axis
        && line.styleKey !== group.styleKey
        && Math.abs(line.coordinate - candidate) < TRUNK_SNAP);
      if (clashing) continue;
      group.coordinate = near ? near.coordinate : candidate;
      break;
    }
    if (group.coordinate === undefined) {
      for (const relationship of group.members) trunkAssignments.delete(relationship);
      continue;
    }
    chosenLines.push({ axis: group.axis, coordinate: group.coordinate, styleKey: group.styleKey });
  }
}

function trunkCandidates(context) {
  const candidate = trunkCandidateShape(context);
  return candidate ? [candidate] : [];
}

function trunkCandidateShape({ conn, start, end, fromSide, toSide }) {
  const assignment = trunkAssignments.get(conn);
  if (!assignment) return null;
  const { axis, coordinate } = assignment.group;
  const sideOffset = (side) => (side === 'right' || side === 'bottom' ? 1 : -1);
  if (axis === 0) {
    const startHorizontal = isHorizontalSide(fromSide);
    const endHorizontal = isHorizontalSide(toSide);
    if (startHorizontal && endHorizontal) return [[coordinate, start[1]], [coordinate, end[1]]];
    if (startHorizontal) {
      const approachY = end[1] + sideOffset(toSide) * TRUNK_LEG;
      return [[coordinate, start[1]], [coordinate, approachY], [end[0], approachY]];
    }
    if (endHorizontal) {
      const exitY = start[1] + sideOffset(fromSide) * TRUNK_LEG;
      return [[start[0], exitY], [coordinate, exitY], [coordinate, end[1]]];
    }
    return null;
  }
  const startHorizontal = isHorizontalSide(fromSide);
  const endHorizontal = isHorizontalSide(toSide);
  if (!startHorizontal && !endHorizontal) return [[start[0], coordinate], [end[0], coordinate]];
  if (!startHorizontal) {
    const approachX = end[0] + sideOffset(toSide) * TRUNK_LEG;
    return [[start[0], coordinate], [approachX, coordinate], [approachX, end[1]]];
  }
  if (!endHorizontal) {
    const exitX = start[0] + sideOffset(fromSide) * TRUNK_LEG;
    return [[exitX, start[1]], [exitX, coordinate], [end[0], coordinate]];
  }
  return null;
}

// The rendered `d` skips each trunk stretch — one shared trunk path carries it
// — while the logical points keep it, so every gate, label, and legend check
// still reasons about the full route.
const trunkRunCache = new Map();
function relationshipTrunkRuns(relationship) {
  const assignment = trunkAssignments.get(relationship);
  if (!assignment) return [];
  if (trunkRunCache.has(relationship)) return trunkRunCache.get(relationship);
  const { axis, coordinate } = assignment.group;
  const points = pathFor(relationship).points;
  const runs = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const [a, b] = [points[index], points[index + 1]];
    if (Math.abs(a[axis] - coordinate) > 0.5 || Math.abs(b[axis] - coordinate) > 0.5) continue;
    const low = Math.min(a[1 - axis], b[1 - axis]);
    const high = Math.max(a[1 - axis], b[1 - axis]);
    if (high - low < 1) continue;
    const last = runs[runs.length - 1];
    if (last && last.endIndex === index) {
      last.endIndex = index + 1;
      last.high = high;
    } else {
      runs.push({ startIndex: index, endIndex: index + 1, low, high });
    }
  }
  trunkRunCache.set(relationship, runs);
  return runs;
}

function bundledRelationshipD(routed, runs) {
  if (!runs.length) return routed.d;
  const inRun = new Set();
  for (const run of runs) {
    for (let index = run.startIndex; index < run.endIndex; index += 1) inRun.add(index);
  }
  const pieces = [];
  let current = [routed.points[0]];
  for (let index = 0; index < routed.points.length - 1; index += 1) {
    if (inRun.has(index)) {
      pieces.push(current);
      current = null;
      continue;
    }
    if (current === null) current = [routed.points[index]];
    current.push(routed.points[index + 1]);
  }
  if (current) pieces.push(current);
  return pieces
    .filter((piece) => piece.length >= 2)
    .map((piece) => roundedPath(piece, 8))
    .join(' ');
}

function bundledTrunkPaths() {
  const clusters = new Map();
  for (const relationship of relationships) {
    const runs = relationshipTrunkRuns(relationship);
    if (!runs.length) continue;
    const { axis, coordinate } = trunkAssignments.get(relationship).group;
    const styleKey = markerStyleOf(relationship);
    // Style is part of the cluster key so differently styled groups can never
    // share one trunk path even if their coordinates ever coincide.
    const key = `${axis}:${coordinate}:${styleKey}`;
    const list = clusters.get(key) || [];
    for (const run of runs) {
      list.push({ low: run.low, high: run.high, styleKey });
    }
    clusters.set(key, list);
  }
  const paths = [];
  for (const [key, runs] of clusters) {
    const [axis, coordinate] = key.split(':').slice(0, 2).map(Number);
    runs.sort((left, right) => left.low - right.low);
    const merged = [];
    for (const run of runs) {
      const last = merged[merged.length - 1];
      if (last && run.low <= last.high + 0.5) last.high = Math.max(last.high, run.high);
      else merged.push({ ...run });
    }
    // Branches that interleave leave short uncovered stretches on an otherwise
    // continuous bus. Bridge them when the bridged line stays clear of every
    // entity; anything wider stays separate so no phantom corridor is drawn.
    const segments = [];
    for (const segment of merged) {
      const last = segments[segments.length - 1];
      const gap = last ? segment.low - last.high : Infinity;
      if (last && gap > 0.5 && gap <= TRUNK_BRIDGE) {
        const probe = axis === 0
          ? { start: [coordinate, last.high], end: [coordinate, segment.low] }
          : { start: [last.high, coordinate], end: [segment.low, coordinate] };
        if (![...entities.values()].some((entity) => segmentIntersectsRect(probe, entity))) {
          last.high = segment.high;
          continue;
        }
      }
      segments.push({ ...segment });
    }
    for (const segment of segments) {
      const [cls] = arrowClassMap[segment.styleKey] || arrowClassMap.default;
      const points = axis === 0
        ? [[coordinate, segment.low], [coordinate, segment.high]]
        : [[segment.low, coordinate], [segment.high, coordinate]];
      paths.push(`        <path data-er-trunk="" data-composition-points="${routePointsValue(points)}" d="${roundedPath(points, 8)}" class="${cls}" stroke-width="1.5"/>`);
    }
  }
  return paths.join('\n');
}

// Bundled labels default to the source-side stub so they never sit on the
// shared trunk, where they would read as annotating every branch at once.
function erLabelPoint(relationship) {
  const points = pathFor(relationship).points;
  if (!trunkAssignments.get(relationship)) return labelPoint(relationship, points);
  return labelPoint({ ...relationship, labelSegment: relationship.labelSegment ?? 0 }, points);
}

function channelFallback({ conn, start, end, fromSide, toSide }) {
  const horizontalPorts = fromSide === 'left' || fromSide === 'right';
  const verticalPorts = fromSide === 'top' || fromSide === 'bottom';
  if (horizontalPorts === verticalPorts) return null;
  const axis = horizontalPorts ? 0 : 1;
  const toPoints = (channel) => (horizontalPorts
    ? [[channel, start[1]], [channel, end[1]]]
    : [[start[0], channel], [end[0], channel]]);
  return { axis, toPoints, low: Math.min(start[axis], end[axis]), high: Math.max(start[axis], end[axis]) };
}

function laneCandidates(context) {
  const lane = laneOffsets.get(context.conn);
  if (lane === undefined) return [];
  const channel = channelFallback(context);
  if (!channel) return [];
  const base = (context.start[channel.axis] + context.end[channel.axis]) / 2;
  return [channel.toPoints(base + lane * LANE_STEP)];
}

// A third entity between two aligned anchors blocks every shared candidate
// family, because each one runs along the same line. These U-shaped detours
// leave the source side, run along a line that clears the obstacle, and enter
// the target from its own side. They are only consulted after the shared
// families fail, so an unobstructed schema keeps its ordinary routes.
const DETOUR_CLEARANCE = 16;
const DETOUR_LEG = 12;

function detourCandidates({ conn, start, end, fromSide, toSide }) {
  const horizontalPorts = fromSide === 'left' || fromSide === 'right';
  const verticalPorts = fromSide === 'top' || fromSide === 'bottom';
  if (horizontalPorts === verticalPorts) return [];
  const travel = horizontalPorts ? 0 : 1;
  const cross = 1 - travel;
  const travelLow = Math.min(start[travel], end[travel]);
  const travelHigh = Math.max(start[travel], end[travel]);
  const crossLow = Math.min(start[cross], end[cross]);
  const crossHigh = Math.max(start[cross], end[cross]);

  const offsets = new Set();
  for (const entity of entities.values()) {
    if (entity.id === conn.from || entity.id === conn.to) continue;
    const boxTravelLow = travel === 0 ? entity.x : entity.y;
    const boxTravelHigh = boxTravelLow + (travel === 0 ? entity.width : entity.height);
    if (boxTravelHigh <= travelLow || boxTravelLow >= travelHigh) continue;
    const boxCrossLow = cross === 0 ? entity.x : entity.y;
    const boxCrossHigh = boxCrossLow + (cross === 0 ? entity.width : entity.height);
    if (boxCrossHigh <= crossLow || boxCrossLow >= crossHigh) continue;
    offsets.add(boxCrossLow - DETOUR_CLEARANCE);
    offsets.add(boxCrossHigh + DETOUR_CLEARANCE);
  }
  if (!offsets.size) return [];

  const point = (travelValue, crossValue) => (travel === 0 ? [travelValue, crossValue] : [crossValue, travelValue]);
  const startDirection = horizontalPorts
    ? (fromSide === 'right' ? 1 : -1)
    : (fromSide === 'bottom' ? 1 : -1);
  const endDirection = horizontalPorts
    ? (toSide === 'left' ? -1 : 1)
    : (toSide === 'top' ? -1 : 1);
  const startLeg = start[travel] + startDirection * DETOUR_LEG;
  const endLeg = end[travel] + endDirection * DETOUR_LEG;

  return [...offsets]
    .sort((left, right) => Math.abs(left - start[cross]) - Math.abs(right - start[cross]))
    .map((offset) => [
      point(startLeg, start[cross]),
      point(startLeg, offset),
      point(endLeg, offset),
      point(endLeg, end[cross]),
    ]);
}

function outsideCandidates(context) {
  const channel = channelFallback(context);
  if (!channel) return [];
  const reach = LANE_STEP * 2;
  return [
    channel.toPoints(channel.high + reach),
    channel.toPoints(channel.low - reach),
  ];
}

// ---- Validation --------------------------------------------------------------
function renderableRelationship(relationship) {
  return entities.has(relationship.from) && entities.has(relationship.to);
}

function rowTextWidths(attribute) {
  const name = textUnits(attribute.name) * nodeTextFit.widthFactor;
  const type = attribute.type ? textUnits(attribute.type) * nodeTextFit.widthFactor : 0;
  return { name, type };
}

function validateEr() {
  const problems = [];
  validateErGridPlacement(er, grid, bands, problems);

  const seenEntityIds = new Set();
  for (const entity of asArray(er.entities)) {
    if (seenEntityIds.has(entity.id)) problems.push(`Entity ids must be unique; "${entity.id}" is declared twice.`);
    seenEntityIds.add(entity.id);

    if (!Number.isFinite(entity.width) && entity.width !== undefined) {
      problems.push(`Entity "${entity.id}" width must be a finite number.`);
    }
    const seenColumns = new Set();
    for (const [attributeIndex, attribute] of asArray(entity.attributes).entries()) {
      if (seenColumns.has(attribute.name)) {
        problems.push(`Entity "${entity.id}" declares attribute "${attribute.name}" twice.`);
      }
      seenColumns.add(attribute.name);
      const { name: nameUnits, type: typeUnits } = rowTextWidths(attribute);
      // entity.width is optional; validateEr sees the authored object, so the
      // overflow check must use the resolved width or an omitted width turns the
      // available space into NaN and silently skips the diagnostic.
      const available = entityWidth(entity) - layout.padX * 2 - layout.keyWidth;
      const needed = nameUnits * layout.rowFont + (typeUnits ? typeUnits * layout.typeFont + 8 : 0);
      if (needed > available) {
        problems.push(
          `Entity "${entity.id}" attribute ${attributeIndex} "${attribute.name}" needs ${Math.ceil(needed)}px of text but only ${Math.floor(available)}px is available — widen the entity, shorten the attribute name, or drop the type.`,
        );
      }
    }
  }

  for (const entity of entities.values()) {
    for (const other of entities.values()) {
      if (entity.id >= other.id) continue;
      if (!rectsOverlap(entity, other, 0)) continue;
      problems.push(`Entity "${entity.id}" overlaps entity "${other.id}".\n${suggestComponentSeparation(entity, other)}`);
    }
  }

  for (const [index, relationship] of relationships.entries()) {
    const id = relationship.id ? ` id "${relationship.id}"` : '';
    if (!entities.has(relationship.from)) {
      problems.push(`Relationship ${index}${id} references unknown source entity "${relationship.from}".`);
      continue;
    }
    if (!entities.has(relationship.to)) {
      problems.push(`Relationship ${index}${id} references unknown target entity "${relationship.to}".`);
      continue;
    }
    if (relationship.from === relationship.to) {
      problems.push(`Relationship ${index}${id} connects entity "${relationship.from}" to itself — draw it between two entities or describe the self-reference in a card.`);
      continue;
    }
    const routed = pathFor(relationship);
    const [start, end] = [routed.points[0], routed.points[routed.points.length - 1]];
    const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (distance < layout.minRelationshipLength) {
      problems.push(`Relationship ${index}${id} "${relationship.from}" -> "${relationship.to}" is too short (${Math.round(distance)}px; minimum ${layout.minRelationshipLength}px) — place the entities farther apart.`);
    }
  }

  for (const [index, entity] of asArray(er.entities).entries()) {
    for (const [attributeIndex, attribute] of asArray(entity.attributes).entries()) {
      if (typeof attribute.references !== 'string') continue;
      const [targetId, targetColumn] = attribute.references.split('.');
      const target = entities.get(targetId);
      if (!target) {
        problems.push(`Entity "${entity.id}" attribute ${attributeIndex} "${attribute.name}" references unknown entity "${targetId}" in "${attribute.references}".`);
        continue;
      }
      if (!asArray(target.attributes).some((candidate) => candidate.name === targetColumn)) {
        problems.push(`Entity "${entity.id}" attribute ${attributeIndex} "${attribute.name}" references unknown attribute "${attribute.references}" — "${targetId}" has no attribute "${targetColumn}".`);
      }
    }
  }

  problems.push(...cleanEndpointSideProblems({
    relations: relationships,
    endpointIds: new Set(entities.keys()),
    pathFor,
    diagramType: 'erd',
    relationCollection: 'relationships',
    fromSideFor: (relationship) => connectionEndpointSide(relationship, 'source'),
    toSideFor: (relationship) => connectionEndpointSide(relationship, 'target'),
    routeHint: 'keep automatic routing so the renderer can use a side-aware bridge, or set truthful fromSide/toSide',
  }));
  problems.push(...cleanFlowProblems({
    relations: relationships,
    obstacles: entities.values(),
    pathFor,
    diagramType: 'erd',
    relationCollection: 'relationships',
    obstacleKind: 'entity',
    routeHint: 'adjust fromSide/toSide, set route/via, or move the entity',
  }));
  problems.push(...cleanCrossingProblems({
    relations: relationships,
    endpointIds: new Set(entities.keys()),
    pathFor,
    diagramType: 'erd',
    relationCollection: 'relationships',
    profile: er.meta?.quality_profile,
    routeHint: 'move the entities so unrelated relationships use separate corridors',
  }));
  problems.push(...cleanAmbiguousCorridorProblems({
    relations: relationships,
    endpointIds: new Set(entities.keys()),
    pathFor,
    diagramType: 'erd',
    relationCollection: 'relationships',
    profile: er.meta?.quality_profile,
    routeHint: 'give the relationships different fromSide/toSide targets, or move an entity so their corridors differ',
  }));
  problems.push(...cleanRouteRhythmProblems({
    relations: relationships,
    endpointIds: new Set(entities.keys()),
    pathFor,
    diagramType: 'erd',
    relationCollection: 'relationships',
    profile: er.meta?.quality_profile,
    routeHint: 'widen the gap between bands so every turn has room to read',
  }));

  const labelRects = [];
  for (const [index, relationship] of relationships.entries()) {
    if (!relationship.label || !renderableRelationship(relationship)) continue;
    const [lx, ly] = erLabelPoint(relationship);
    const width = Math.max(30, textUnits(relationship.label) * 4.8 + 10);
    labelRects.push({
      relation: relationship,
      relationIndex: index,
      label: relationship.label,
      x: lx - width / 2,
      y: ly - 10,
      width,
      height: 14,
      lx,
      ly,
    });
  }
  for (const rect of labelRects) {
    for (const entity of entities.values()) {
      if (!rectsOverlap(rect, entity, -2)) continue;
      problems.push(`Label "${rect.label}" overlaps entity "${entity.id}" — adjust labelDx/labelDy/labelSegment or set labelAt.\n${suggestLabelObstacleFix(rect, rect.lx, rect.ly, entity, 'entity')}`);
    }
  }
  problems.push(...cleanLabelRouteClearanceProblems({
    relations: relationships,
    labels: labelRects,
    endpointIds: new Set(entities.keys()),
    pathFor,
    diagramType: 'erd',
    relationCollection: 'relationships',
    profile: er.meta?.quality_profile,
  }));

  if (problems.length) {
    throwDiagnosticProblems('Entity-relationship layout validation failed', problems, {
      code: 'layout/constraint',
      subject: { diagramType: 'erd' },
    });
  }
}

function buildLayoutReport() {
  return {
    diagram_type: 'erd',
    viewBox,
    layout,
    entities: [...entities.values()].map(entityBox),
    relationships: relationships
      .filter(renderableRelationship)
      .map((relationship) => ({
        ...relationshipPath(relationship, pathFor(relationship), relationship.labelAt),
        fromCardinality: cardinalityOf(relationship, 'from'),
        toCardinality: cardinalityOf(relationship, 'to'),
      })),
  };
}

// ---- Rendering ---------------------------------------------------------------
function renderEntityColumnRows(entity) {
  return entity.attributes.map((attribute, index) => {
    const rowTop = entity.y + metrics.headerH + index * metrics.rowH;
    const baseline = rowTop + metrics.rowH - 5;
    const keyGlyph = attribute.key
      ? `<text x="${entity.x + layout.padX}" y="${baseline}" class="${KEY_ACCENT[attribute.key] || 't-muted'}" font-size="${layout.keyFont}" font-weight="600">${esc(attribute.key.toUpperCase())}</text>`
      : '';
    const nameX = entity.x + layout.padX + layout.keyWidth;
    const typeSpace = attribute.type ? Math.min(96, textUnits(attribute.type) * layout.typeFont * nodeTextFit.widthFactor) : 0;
    const nameFontSize = fittedNodeFontSize(
      attribute.name,
      Math.max(40, entity.x + entity.width - layout.padX - typeSpace - nameX),
      layout.rowFont,
      layout.rowFontMinimum,
    );
    const type = attribute.type
      ? `<text x="${entity.x + entity.width - layout.padX}" y="${baseline}" class="t-muted" font-size="${layout.typeFont}" text-anchor="end">${esc(attribute.type)}</text>`
      : '';
    return `          <g data-detail="context" data-er-row="${index}">
            <line x1="${entity.x}" y1="${rowTop}" x2="${entity.x + entity.width}" y2="${rowTop}" class="c-grid" stroke-width="0.5"/>
            ${keyGlyph}
            <text x="${nameX}" y="${baseline}" class="t-primary" font-size="${nameFontSize}">${esc(attribute.name)}</text>
            ${type}
          </g>`;
  }).join('\n');
}

function renderEntity(entity) {
  const header = entity.y + metrics.headerH;
  // A banded table already carries its domain on the band, so repeating the tag
  // in the header would be noise; the header note falls back to the tag only for
  // a table that has no band of its own.
  const detail = entity.sublabel ?? (bandedEntityIds.has(entity.id) ? undefined : entity.tag);
  const detailFontSize = detail
    ? fittedNodeFontSize(detail, 60, layout.detailPreferred, layout.detailMinimum)
    : 0;
  const detailFits = detail ? textUnits(detail) * detailFontSize * nodeTextFit.widthFactor <= 64 : false;
  const labelFontSize = fittedNodeFontSize(entity.label, entity.width - 34, layout.headerFont, layout.headerFontMinimum);
  const passport = {
    kind: 'database',
    sublabel: entity.sublabel,
    tag: entity.tag,
    context: i18nText(er.meta.locale, 'node.context.erd'),
  };
  const sublabel = detailFits
    ? `\n          <text data-detail="context" x="${entity.x + entity.width - layout.padX}" y="${entity.y + 16}" class="t-muted" font-size="${detailFontSize}" text-anchor="end">${esc(detail)}</text>`
    : '';
  const rows = renderEntityColumnRows(entity);
  return `        <g ${focusNodeAttrs(entity.id, entity.label, passport, er.meta.locale)}>
          ${focusNodeTitle(entity.label, passport)}
          <rect x="${entity.x}" y="${entity.y}" width="${entity.width}" height="${entity.height}" rx="5" class="c-mask"/>
          <rect x="${entity.x}" y="${entity.y}" width="${entity.width}" height="${entity.height}" rx="5" class="${ENTITY_FILL}"${animateAttr(er.meta, 'node', entitySteps.get(entity.id))} stroke-width="1.5"/>
          ${renderSemanticSigil('database', { x: entity.x + 6, y: entity.y + 5 })}
          <text data-node-label="" x="${entity.x + entity.width / 2}" y="${entity.y + 18}" class="t-primary" font-size="${labelFontSize}" font-weight="600" text-anchor="middle">${esc(entity.label)}</text>${sublabel}
          <line x1="${entity.x}" y1="${header}" x2="${entity.x + entity.width}" y2="${header}" class="c-grid" stroke-width="1"/>
${rows}
        </g>`;
}

function renderRelationshipPath(relationship, index) {
  const [cls] = arrowClassMap[markerStyleOf(relationship)] || arrowClassMap.default;
  const routed = pathFor(relationship);
  const d = bundledRelationshipD(routed, relationshipTrunkRuns(relationship));
  const strokeWidth = Number.isFinite(relationship.width) ? relationship.width : 1.5;
  return `        <path ${focusEdgeAttrs(relationship.from, relationship.to, relationship.label, index, relationship.id)} data-composition-points="${routePointsValue(routed.points)}" d="${d}" class="${cls}"${animateAttr(er.meta, 'edge', index)} stroke-width="${strokeWidth}" marker-start="url(#${cardinalityMarkerId(relationship, 'from')})" marker-end="url(#${cardinalityMarkerId(relationship, 'to')})"/>`;
}

function renderRelationshipLabel(relationship, index) {
  if (!relationship.label) return '';
  const [lx, ly] = erLabelPoint(relationship);
  const width = Math.max(30, textUnits(relationship.label) * 4.8 + 10);
  return `        <g data-detail="context" ${focusEdgeAttrs(relationship.from, relationship.to, relationship.label, index, relationship.id)}>
          <rect x="${lx - width / 2}" y="${ly - 10}" width="${width}" height="14" rx="3" class="c-mask"/>
          <text x="${lx}" y="${ly}" class="${variantAccent(relationship.variant)}" font-size="8" text-anchor="middle">${esc(relationship.label)}</text>
        </g>`;
}

// The swatch repeats the marker's own ink and weight, so the legend shows the
// reader the exact glyph the diagram draws rather than a thinner stand-in.
function legendSwatch(entry) {
  const y = entry.baseline - 10;
  const ink = 'style="stroke: var(--text-muted)" stroke-width="1.75" fill="none"';
  if (entry.kind === 'one' || entry.kind === 'many') {
    const symbol = entry.kind === 'many'
      ? `<path d="M ${entry.x + 18} ${y + 6} L ${entry.x + 2} ${y + 1} M ${entry.x + 18} ${y + 6} L ${entry.x + 2} ${y + 6} M ${entry.x + 18} ${y + 6} L ${entry.x + 2} ${y + 11}" ${ink}/>`
      : `<path d="M ${entry.x + 10} ${y + 1} L ${entry.x + 10} ${y + 11}" ${ink}/>`;
    return symbol;
  }
  if (entry.kind === 'optional') {
    return `<circle cx="${entry.x + 9}" cy="${y + 6}" r="3" ${ink}/>`;
  }
  return `<text x="${entry.x + 2}" y="${y + 10}" class="${KEY_ACCENT[entry.kind] || 't-muted'}" font-size="8.5" font-weight="700">${esc(entry.kind.toUpperCase())}</text>`;
}

function renderLegend() {
  const relationshipObstacles = relationshipLegendObstacles(relationships, {
    pointsFor: (relationship) => (renderableRelationship(relationship) ? pathFor(relationship).points : []),
    labelRectFor: (relationship) => {
      if (!relationship.label || !renderableRelationship(relationship)) return null;
      const [x, y] = erLabelPoint(relationship);
      const width = Math.max(30, textUnits(relationship.label) * 4.8 + 10);
      return { x: x - width / 2, y: y - 10, width, height: 14 };
    },
  });
  const contentBottom = Math.max(0, ...[...entities.values()].map((entity) => entity.y + entity.height));
  return renderResolvedLegend({
    entries: erLegendEntries,
    locale: er.meta.locale,
    layout: {
      x: layout.margin,
      baselineY: legendY(),
      width: viewBox[0] - layout.margin * 2,
      fontSize: 9,
      minTitleY: contentBottom + 8,
      obstacles: relationshipObstacles,
      unfit: er.meta?.legend === undefined ? 'hide' : 'error',
      diagramType: 'erd',
    },
    renderSwatch: legendSwatch,
    labelWeight: 600,
  });
}

function renderSvg() {
  return `      <svg viewBox="0 0 ${viewBox[0]} ${viewBox[1]}" ${svgRootAttrs(er.meta)}>
${svgAccessibleText(er.meta, 'erd')}
${renderDefinitions(renderCardinalityDefs())}

        <!-- Background Grid -->
        <rect width="100%" height="100%" fill="url(#grid)" />

        <!-- Domain bands (behind the routes so a channel is never washed out) -->
${renderDomainBands()}

        <!-- Bundled relationship trunks (under the branches: a bus runs close
             to the shared side, so a cardinality glyph that reaches further out
             has to stay readable over it, and the ring's mask has to be able to
             punch through) -->
${bundledTrunkPaths()}

        <!-- Relationship paths (before entities for correct z-order) -->
${relationships.map((relationship, index) => (renderableRelationship(relationship) ? renderRelationshipPath(relationship, index) : '')).filter(Boolean).join('\n')}

        <!-- Entities -->
${[...entities.values()].map(renderEntity).join('\n\n')}

        <!-- Relationship labels -->
${relationships.map((relationship, index) => (renderableRelationship(relationship) ? renderRelationshipLabel(relationship, index) : '')).filter(Boolean).join('\n')}

        <!-- Legend -->
${renderLegend()}
      </svg>`;
}

validateEr();
if (layoutJsonMode) {
  console.log(JSON.stringify(buildLayoutReport(), null, 2));
  process.exit(0);
}
writeDiagram({
  outPath,
  template,
  diagramType: 'erd',
  meta: er.meta,
  svg: renderSvg(),
  cards: er.cards,
  sourceEvidence,
});
