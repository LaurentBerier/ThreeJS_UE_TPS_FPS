import * as THREE from 'three';
import Component from '../../Component.js'

import {Pathfinding} from 'three-pathfinding'


export default class Navmesh extends Component{
    constructor(scene, mesh){
        super();
        this.scene = scene;
        this.name = "Navmesh";
        this.zone = "level1";
        this.mesh = mesh;
    }

    Initialize(){
        this.pathfinding = new Pathfinding();

        this.mesh.traverse( ( node ) => {
            if(node.isMesh){ 
                this.pathfinding.setZoneData(this.zone, Pathfinding.createZone(node.geometry));
            }
        });
    }

    GetRandomNode(p, range){
        const groupID = this.pathfinding.getGroup(this.zone, p);
        if(groupID === null){ return null; }
        return this.pathfinding.getRandomNode(this.zone, groupID, p, range);
    }

    FindPath(a, b){
        const groupID = this.pathfinding.getGroup(this.zone, a);
        // getGroup returns null when the start point is off the navmesh (e.g. the
        // agent clipped through a collision). findPath would then crash trying to
        // read groups[null], so bail out with no path instead.
        if(groupID === null){ return null; }
        return this.pathfinding.findPath(a, b, this.zone, groupID);
    }

    GetGroup(p){
        return this.pathfinding.getGroup(this.zone, p);
    }

    // Closest navmesh node to p within the group. Try the strict lookup first (the polygon that
    // actually CONTAINS p), but fall back to the nearest centroid when p isn't strictly inside any
    // polygon — a point a hair off an edge, or whose Y is slightly off the mesh plane, makes the
    // strict (checkPolygon) form return null. A null node here is dangerous: callers treat "no node"
    // as "off the navmesh" and then move the agent UNCLAMPED (straight through walls), so always
    // hand back a real node when the group is valid.
    GetClosestNode(p, groupID){
        return this.pathfinding.getClosestNode(p, this.zone, groupID, true)
            || this.pathfinding.getClosestNode(p, this.zone, groupID, false);
    }

    // Clamps the move from start->end so it stays on the navmesh. Writes the
    // clamped position into outTarget and returns the node it ended up on.
    ClampStep(start, end, node, groupID, outTarget){
        return this.pathfinding.clampStep(start, end, node, this.zone, groupID, outTarget);
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
        const groupID = this.pathfinding.getGroup(this.zone, start);
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