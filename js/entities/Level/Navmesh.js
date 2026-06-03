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

    GetClosestNode(p, groupID){
        return this.pathfinding.getClosestNode(p, this.zone, groupID, true);
    }

    // Clamps the move from start->end so it stays on the navmesh. Writes the
    // clamped position into outTarget and returns the node it ended up on.
    ClampStep(start, end, node, groupID, outTarget){
        return this.pathfinding.clampStep(start, end, node, this.zone, groupID, outTarget);
    }
}