import * as THREE from 'three';
import Component from '../../Component.js'
import { AmmoHelper } from '../../AmmoLib.js'

import {Pathfinding} from 'three-pathfinding'

// ---------------------------------------------------------------------------------------------
// SPATIAL INDEX over the navmesh polygons.
//
// three-pathfinding's getGroup / getClosestNode / getRandomNode are LINEAR SCANS over every
// polygon in the zone (thousands of triangles on the journey navmesh) — and the AI hammers them:
// every repath calls getGroup + getClosestNode x2, every combat reposition samples getRandomNode
// a dozen times, and the beast's SmoothPath runs getClosestNode per path corner ~8x a second
// while chasing. Those scans, bursty and synchronized across the squad, were the core of the
// "game stutters when the enemy AI is active" complaint.
//
// The fix is a uniform grid hash: each triangle is bucketed by its XZ AABB once at load, and all
// the hot queries walk a few buckets (expanding rings for nearest-lookups) instead of the whole
// mesh. The library's own findPath endpoint lookups are routed through the same index by
// overriding the INSTANCE's getClosestNode (findPath and our SmoothPath both call it via `this`),
// so the A*/funnel algorithms are untouched but never pay a full-mesh scan again.
// ---------------------------------------------------------------------------------------------
const GRID_CELL = 4.0;   // metres per bucket — the nav cells are 2.75 m, so a bucket holds a handful of tris
const MAX_RINGS = 14;    // nearest-search cap: 14 rings ≈ 56 m, matching the ~50 m acceptance the
                         // library's loose getGroup scan used ("too far off the mesh" stays null)
const KEY_OFF = 512;     // cell-key offset: supports |cell index| < 512 (≈ ±2 km of world)

export default class Navmesh extends Component{
    constructor(scene, mesh){
        super();
        this.scene = scene;
        this.name = "Navmesh";
        this.zone = "level1";
        this.mesh = mesh;
        // Scratch vectors for the endpoint snapping in FindPath (no per-call allocation).
        this._snapA = new THREE.Vector3();
        this._snapB = new THREE.Vector3();
    }

    Initialize(){
        this.pathfinding = new Pathfinding();

        this.mesh.traverse( ( node ) => {
            if(node.isMesh){
                this.pathfinding.setZoneData(this.zone, Pathfinding.createZone(node.geometry));
            }
        });

        this._BuildSpatialIndex();

        // Route the library's internal endpoint lookups through the index. findPath calls
        // this.getClosestNode twice per path (start + end, strict); SmoothPath calls it per
        // corner. Identical results, O(bucket) instead of O(whole mesh).
        this._origGetClosestNode = this.pathfinding.getClosestNode.bind(this.pathfinding);
        this.pathfinding.getClosestNode = (pos, zoneID, groupID, checkPolygon = false) =>
            this._FastClosestNode(pos, groupID, checkPolygon);
    }

    // Bucket every polygon of every group by its XZ AABB. Entries keep direct references to the
    // zone's node objects (A* mutates fields on those same objects, so identity matters) plus the
    // triangle's three vertices for the containment test.
    _BuildSpatialIndex(){
        this.grid = null;
        const zone = this.pathfinding.zones[this.zone];
        if(!zone){ return; }
        this.grid = new Map();
        let count = 0;
        zone.groups.forEach((group, groupID) => {
            for(const node of group){
                const a = zone.vertices[node.vertexIds[0]];
                const b = zone.vertices[node.vertexIds[1]];
                const c = zone.vertices[node.vertexIds[2]];
                const entry = { node, groupID, a, b, c };
                const i0 = Math.floor(Math.min(a.x, b.x, c.x) / GRID_CELL);
                const i1 = Math.floor(Math.max(a.x, b.x, c.x) / GRID_CELL);
                const j0 = Math.floor(Math.min(a.z, b.z, c.z) / GRID_CELL);
                const j1 = Math.floor(Math.max(a.z, b.z, c.z) / GRID_CELL);
                for(let j = j0; j <= j1; j++){
                    for(let i = i0; i <= i1; i++){
                        const key = (i + KEY_OFF) * (KEY_OFF * 2) + (j + KEY_OFF);
                        let arr = this.grid.get(key);
                        if(!arr){ arr = []; this.grid.set(key, arr); }
                        arr.push(entry);
                    }
                }
                count++;
            }
        });
        console.log(`[Navmesh] spatial index: ${count} polygons in ${this.grid.size} buckets`);
    }

    _Cell(i, j){
        return this.grid.get((i + KEY_OFF) * (KEY_OFF * 2) + (j + KEY_OFF));
    }

    // The library's containment test (even-odd point-in-polygon in XZ) with a WIDENED vertical
    // window: ±1.0 m around the polygon's vertex heights, up from the library's ±0.5. The navmesh
    // is a 2.75 m grid triangulation of the terrain, so between grid corners its interpolated
    // surface can sit several tens of cm off the true rugged ground the agents actually ride
    // (StanceHeightAt seats them on the stance's contact, above HeightAt on strong slopes). With
    // the tight window those agents failed strict containment, so FindPath snapped their endpoint
    // to a node CENTROID up to a cell away — paths started/ended visibly offset on every repath
    // near slopes (a walk-back wobble that fed the "stuck" look). The level has a single navmesh
    // layer (no vertically stacked walkable floors), so widening the window is unambiguous.
    _InPolygon(p, e){
        const minY = Math.min(e.a.y, e.b.y, e.c.y);
        const maxY = Math.max(e.a.y, e.b.y, e.c.y);
        if(p.y >= maxY + 1.0 || p.y <= minY - 1.0){ return false; }
        let inside = false;
        const vs = [e.a, e.b, e.c];
        for(let i = 0, j = 2; i < 3; j = i++){
            const vi = vs[i], vj = vs[j];
            if(((vi.z <= p.z && p.z < vj.z) || (vj.z <= p.z && p.z < vi.z)) &&
               (p.x < (vj.x - vi.x) * (p.z - vi.z) / (vj.z - vi.z) + vi.x)){ inside = !inside; }
        }
        return inside;
    }

    // Nearest indexed polygon to p (by 3D centroid distance, matching the library), optionally
    // filtered to one group. Expanding-ring search from p's bucket; stops as soon as no closer
    // centroid can exist in a farther ring, or at the MAX_RINGS cap (=> null, "off the mesh").
    _NearestEntry(p, groupID){
        if(!this.grid){ return null; }
        const ci = Math.floor(p.x / GRID_CELL), cj = Math.floor(p.z / GRID_CELL);
        let best = null, bestD2 = Infinity;
        for(let r = 0; r <= MAX_RINGS; r++){
            // Once we have a candidate, a ring whose NEAREST possible cell edge is beyond it
            // cannot contain a closer centroid.
            if(best !== null){
                const minPossible = (r - 1) * GRID_CELL;
                if(minPossible > 0 && minPossible * minPossible > bestD2){ break; }
            }
            for(let dj = -r; dj <= r; dj++){
                const onJEdge = (dj === -r || dj === r);
                for(let di = -r; di <= r; di++){
                    if(!onJEdge && di !== -r && di !== r){ continue; }   // ring perimeter only
                    const cell = this._Cell(ci + di, cj + dj);
                    if(!cell){ continue; }
                    for(const e of cell){
                        if(groupID !== null && e.groupID !== groupID){ continue; }
                        const c = e.node.centroid;
                        const dx = c.x - p.x, dy = c.y - p.y, dz = c.z - p.z;
                        const d2 = dx * dx + dy * dy + dz * dz;
                        if(d2 < bestD2){ bestD2 = d2; best = e; }
                    }
                }
            }
        }
        return best;
    }

    // Index-backed replacement for pathfinding.getClosestNode (same signature semantics).
    // strict (checkPolygon=true): only a polygon that CONTAINS p, else null — containment can
    // only happen in p's own bucket, so this is a single-bucket test.
    _FastClosestNode(p, groupID, checkPolygon){
        if(!this.grid){ return this._origGetClosestNode(p, this.zone, groupID, checkPolygon); }
        if(checkPolygon){
            const cell = this._Cell(Math.floor(p.x / GRID_CELL), Math.floor(p.z / GRID_CELL));
            if(cell){
                for(const e of cell){
                    if(e.groupID === groupID && this._InPolygon(p, e)){ return e.node; }
                }
            }
            return null;
        }
        const e = this._NearestEntry(p, groupID);
        return e ? e.node : null;
    }

    GetRandomNode(p, range){
        const groupID = this.GetGroup(p);
        if(groupID === null){ return null; }
        if(!this.grid){ return this.pathfinding.getRandomNode(this.zone, groupID, p, range); }
        // Rejection-sample buckets inside the disc first (a handful of probes almost always
        // lands); sweep the disc as a bounded fallback for sparse edges. Matches the library's
        // 3D range test; returns a centroid Vector3 like the library did — but null (not a
        // zeroed vector) when nothing walkable is in range, which callers already handle.
        const rangeSq = range * range;
        const cellsR = Math.max(0, Math.ceil(range / GRID_CELL));
        const ci = Math.floor(p.x / GRID_CELL), cj = Math.floor(p.z / GRID_CELL);
        const span = cellsR * 2 + 1;
        for(let attempt = 0; attempt < 24; attempt++){
            const cell = this._Cell(ci + ((Math.random() * span) | 0) - cellsR,
                                    cj + ((Math.random() * span) | 0) - cellsR);
            if(!cell || !cell.length){ continue; }
            const e = cell[(Math.random() * cell.length) | 0];
            if(e.groupID !== groupID){ continue; }
            const c = e.node.centroid;
            const dx = c.x - p.x, dy = c.y - p.y, dz = c.z - p.z;
            if(dx * dx + dy * dy + dz * dz <= rangeSq){ return c; }
        }
        const cands = [];
        for(let j = cj - cellsR; j <= cj + cellsR; j++){
            for(let i = ci - cellsR; i <= ci + cellsR; i++){
                const cell = this._Cell(i, j);
                if(!cell){ continue; }
                for(const e of cell){
                    if(e.groupID !== groupID){ continue; }
                    const c = e.node.centroid;
                    const dx = c.x - p.x, dy = c.y - p.y, dz = c.z - p.z;
                    if(dx * dx + dy * dy + dz * dz <= rangeSq){ cands.push(c); }
                }
            }
        }
        return cands.length ? cands[(Math.random() * cands.length) | 0] : null;
    }

    FindPath(a, b){
        const groupID = this.GetGroup(a);
        // getGroup returns null when the start point is off the navmesh (e.g. the
        // agent clipped through a collision). findPath would then crash trying to
        // read groups[null], so bail out with no path instead.
        if(groupID === null){ return null; }
        if(!this.grid){ return this.pathfinding.findPath(a, b, this.zone, groupID); }
        // findPath needs BOTH endpoints strictly inside a polygon or it returns null. That
        // contract froze every chase whose DESTINATION was a hair off the walkable surface (the
        // player up on a bund crest, inside a structure footprint's clearance ring, past the
        // arena moat): no path, so the enemy just stood there — a big slice of the "they get
        // stuck" reports. Snap off-mesh endpoints to the nearest walkable polygon in the start's
        // group, so the path always runs to the closest REACHABLE spot instead of not existing.
        const a2 = this._SnapEndpoint(a, groupID, this._snapA);
        const b2 = this._SnapEndpoint(b, groupID, this._snapB);
        if(!a2 || !b2){ return null; }
        return this.pathfinding.findPath(a2, b2, this.zone, groupID);
    }

    _SnapEndpoint(p, groupID, out){
        if(this._FastClosestNode(p, groupID, true)){ return out.copy(p); }   // already on the mesh: keep exact
        const e = this._NearestEntry(p, groupID);
        if(!e){ return null; }
        return out.copy(e.node.centroid);
    }

    GetGroup(p){
        if(!this.grid){ return this.pathfinding.getGroup(this.zone, p); }
        const e = this._NearestEntry(p, null);
        return e ? e.groupID : null;
    }

    // Closest navmesh node to p within the group. Try the strict lookup first (the polygon that
    // actually CONTAINS p), but fall back to the nearest centroid when p isn't strictly inside any
    // polygon — a point a hair off an edge, or whose Y is slightly off the mesh plane, makes the
    // strict (checkPolygon) form return null. A null node here is dangerous: callers treat "no node"
    // as "off the navmesh" and then move the agent UNCLAMPED (straight through walls), so always
    // hand back a real node when the group is valid.
    GetClosestNode(p, groupID){
        return this._FastClosestNode(p, groupID, true)
            || this._FastClosestNode(p, groupID, false);
    }

    // Clamps the move from start->end so it stays on the navmesh. Writes the
    // clamped position into outTarget and returns the node it ended up on.
    // (three-pathfinding's clampStep is already a local BFS from the current node — cheap.)
    ClampStep(start, end, node, groupID, outTarget){
        return this.pathfinding.clampStep(start, end, node, this.zone, groupID, outTarget);
    }

    // Snap a desired SPAWN point onto the walkable surface so an entity never starts inside collision
    // (a prop/wall the hard-coded spawn coords happened to land in). If the point is already strictly
    // inside a navmesh polygon it's left exactly where it is (valid spawn, no drift); otherwise it's
    // pulled to the nearest node centroid — which, because the navmesh is the collision-free floor, is
    // guaranteed clear of geometry. The original Y is preserved (feet stay at the intended ground line).
    // Returns outTarget (or a fresh Vector3), set to the safe position.
    NearestWalkablePoint(p, outTarget){
        const out = outTarget || new THREE.Vector3();
        out.copy(p);
        const groupID = this.GetGroup(p);
        if(groupID === null){ return out; }              // can't resolve a group: leave the point as-is
        // Already strictly on a polygon? Keep it (checkPolygon=true returns null when p is off-mesh).
        if(this.pathfinding.getClosestNode(p, this.zone, groupID, true)){ return out; }
        const node = this.pathfinding.getClosestNode(p, this.zone, groupID, false);
        if(node && node.centroid){ out.set(node.centroid.x, p.y, node.centroid.z); }
        return out;
    }

    // Pick a SAFE spawn near `p`: snap onto the navmesh first (NearestWalkablePoint), then — because the
    // level's per-mesh colliders are CONVEX HULLS, so a container becomes a SOLID box and the navmesh
    // can still cover the floor under it — verify the spot isn't buried in static collision. If it is,
    // sample walkable nodes outward and take the first with a clear approach. Falls back to the snapped
    // point. Needs the physics world for the enclosure test (the navmesh alone can't see the boxes).
    FindClearSpawn(p, physicsWorld, outTarget){
        const out = outTarget || new THREE.Vector3();
        this.NearestWalkablePoint(p, out);
        if(!physicsWorld || !AmmoHelper.IsEnclosedByStatic(physicsWorld, out)){ return out; }
        // Buried: search outward on the navmesh for an open spot.
        const cand = new THREE.Vector3();
        for(const range of [2.5, 4.0, 6.0, 8.0, 11.0]){
            for(let i = 0; i < 6; i++){
                const node = this.GetRandomNode(out, range);   // returns a walkable position (Vector3) or null
                if(!node){ continue; }
                cand.set(node.x, node.y, node.z);
                if(!AmmoHelper.IsEnclosedByStatic(physicsWorld, cand)){ out.copy(cand); return out; }
            }
        }
        return out;   // nothing better found; keep the snapped point
    }

    // Add agent-radius clearance to a funnel path so a WIDE agent rounds corners instead of
    // clipping the wall. three-pathfinding's findPath runs the simple-stupid-funnel string-pull,
    // which plants each waypoint *exactly on the convex wall-corner vertex* it pulls taut against.
    // Because this shared mesh isn't eroded by an agent radius (as a baked AAA navmesh would be),
    // a big body is routed flush into those corners and grinds. The AAA-equivalent fix at query
    // time: push every interior corner inward along the angle bisector of the turn — which points
    // into the walkable interior, away from the wall vertex — by `clearance` metres, then
    // re-project the shifted point back onto the mesh (clampStep) so it can never land in a wall
    // on a thin span. Endpoints (the agent's own position is not in the list; the final goal) are
    // left exact so the beast still arrives precisely on its target.
    //   start    : the agent's current position (the implicit predecessor of path[0])
    //   path     : array of THREE.Vector3 waypoints from FindPath (may be null/short)
    //   clearance: how far to hold off each corner (≈ the agent's body radius), metres
    // Returns a NEW array of THREE.Vector3 (or the original path when there's nothing to smooth).
    SmoothPath(start, path, clearance = 0.7){
        if(!path || path.length < 2 || !start){ return path; }
        const groupID = this.GetGroup(start);
        if(groupID === null){ return path; }

        const out = [];
        const inDir = new THREE.Vector3();
        const outDir = new THREE.Vector3();
        const bis = new THREE.Vector3();
        const adj = new THREE.Vector3();
        const clamped = new THREE.Vector3();

        for(let i = 0; i < path.length; i++){
            const cur = path[i];
            const next = path[i + 1];
            // Keep the final goal exactly where it is so arrival stays precise.
            if(!next){ out.push(cur.clone()); continue; }

            const prev = i === 0 ? start : path[i - 1];
            inDir.set(prev.x - cur.x, 0, prev.z - cur.z);    // corner -> prev  (into walkable)
            outDir.set(next.x - cur.x, 0, next.z - cur.z);   // corner -> next  (into walkable)
            if(inDir.lengthSq() < 1e-8 || outDir.lengthSq() < 1e-8){ out.push(cur.clone()); continue; }
            inDir.normalize();
            outDir.normalize();

            bis.copy(inDir).add(outDir);                     // inward bisector, away from the wall
            // Near-straight segment (prev, cur, next collinear) => no real corner to round.
            if(bis.lengthSq() < 1e-6){ out.push(cur.clone()); continue; }
            bis.normalize().multiplyScalar(clearance);
            adj.set(cur.x + bis.x, cur.y, cur.z + bis.z);

            // Re-project onto the mesh: clampStep finds the nearest walkable point to `adj`,
            // starting from the corner's own polygon, so an over-push on a narrow ledge snaps back.
            const node = this.pathfinding.getClosestNode(cur, this.zone, groupID, true)
                      || this.pathfinding.getClosestNode(cur, this.zone, groupID, false);
            if(node){
                this.pathfinding.clampStep(cur, adj, node, this.zone, groupID, clamped);
                out.push(clamped.clone());
            }else{
                out.push(adj.clone());
            }
        }
        return out;
    }
}
