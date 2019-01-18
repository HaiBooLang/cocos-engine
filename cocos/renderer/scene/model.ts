// Copyright (c) 2017-2018 Xiamen Yaji Software Co., Ltd.
import { Material } from '../../3d/assets/material';
import { IRenderingSubmesh } from '../../3d/assets/mesh';
import { aabb } from '../../3d/geom-utils';
import { Vec3 } from '../../core/value-types';
import { mat4 } from '../../core/vmath';
import { GFXBuffer } from '../../gfx/buffer';
import { GFXCommandBuffer } from '../../gfx/command-buffer';
import { GFXBufferUsageBit, GFXCommandBufferType, GFXMemoryUsageBit } from '../../gfx/define';
import { GFXDevice } from '../../gfx/device';
import { UBOLocal } from '../../pipeline/render-pipeline';
import { Effect } from '../core/effect';
import { Pass } from '../core/pass';
import { RenderScene } from './render-scene';
import { Node } from '../../scene-graph/node';
import { RecyclePool } from '../../3d/memop';
import { SubModel } from './submodel';
import { GFXPipelineState } from '../../gfx/pipeline-state';

const _temp_floatx16 = new Float32Array(16);
const _temp_mat4 = mat4.create();

const _subMeshPool = new RecyclePool(() => {
    return new SubModel();
}, 100);

/**
 * A representation of a model
 */
export class Model {

    protected _device: GFXDevice;
    protected _type: string;
    private _scene: RenderScene | null;
    private _id: number;
    private _isEnable: boolean;
    private _node: Node | null;
    private _viewID: number;
    private _cameraID: number;
    private _userKey: number;
    private _worldBounds: aabb;
    private _modelBounds: aabb;
    private _cmdBuffers: GFXCommandBuffer[];
    private _uboLocal: UBOLocal;
    private _localUBO: GFXBuffer | null;
    private _subModels: SubModel[];
    private _matPSORecord: Map<Material, GFXPipelineState[]>;
    private _matRefCount: Map<Material, number>;
    /**
     * Setup a default empty model
     */
    constructor () {
        this._scene = null;
        this._id = 0;

        this._type = 'default';
        this._isEnable = true;
        this._node = null;
        this._viewID = -1;
        this._cameraID = -1;
        this._userKey = -1;
        this._cmdBuffers = new Array<GFXCommandBuffer>();
        this._uboLocal = new UBOLocal();
        this._localUBO = null;
        this._device = cc.director.root.device;
        this._subModels = new Array<SubModel>();
        this._matPSORecord = new Map<Material, GFXPipelineState[]>();
        this._matRefCount = new Map<Material, number>();
    }

    public initialize () {
        this._localUBO = this._device.createBuffer({
            usage: GFXBufferUsageBit.UNIFORM | GFXBufferUsageBit.TRANSFER_DST,
            memUsage: GFXMemoryUsageBit.HOST,
            size: UBOLocal.SIZE,
            stride: UBOLocal.SIZE,
        });
        if (this._localUBO) {
            this._localUBO.update(this._uboLocal.view);
        }
    }

    public destroy () {
        for (const subModel of this._subModels) {
            subModel.destroy();
            _subMeshPool.remove(subModel);
        }
    }

    set scene (scene: RenderScene | null) {
        this._scene = scene;

        if (this._scene) {
            this._id = this._scene.generateModelId();
        }
    }

    get scene (): RenderScene | null {
        return this._scene;
    }

    get id (): number {
        return this._id;
    }

    get subModelNum (): number {
        return this._subModels.length;
    }

    public getSubModel (idx: number): SubModel {
        return this._subModels[idx];
    }

    public _updateTransform () {
        if (this._node == null) {
            return;
        }
        if (!this._node._hasChanged || !this._worldBounds) {
            return;
        }
        this._node.updateWorldTransformFull();
        this._modelBounds.transform(this._node._mat, this._node._pos,
            this._node._rot, this._node._scale, this._worldBounds);
    }

    public updateUBOs () {
        if (this._node == null) {
            return;
        }
        mat4.array(_temp_floatx16, this._node._mat);
        this._node._mat.invert(_temp_mat4);
        this._uboLocal.view.set(_temp_floatx16, UBOLocal.MAT_WORLD_OFFSET);
        mat4.array(_temp_floatx16, _temp_mat4);
        this._uboLocal.view.set(_temp_floatx16, UBOLocal.MAT_WORLD_IT_OFFSET);

        this._localUBO!.update(this._uboLocal.view);

        for (const mat of this._matPSORecord.keys()) {
            for (const pass of mat.passes) {
                pass.update();
            }
            for (const pso of this._matPSORecord.get(mat)!) {
                pso.pipelineLayout.layouts[0].update();
            }
        }
    }

    /**
     * Create the bounding shape of this model
     * @param {vec3} minPos the min position of the model
     * @param {vec3} maxPos the max position of the model
     */
    public createBoundingShape (minPos?: Vec3, maxPos?: Vec3) {
        if (!minPos || !maxPos) { return; }
        this._modelBounds = aabb.fromPoints(aabb.create(), minPos, maxPos);
        this._worldBounds = aabb.clone(this._modelBounds);
    }

    public enable (isEnable: boolean) {
        this._isEnable = isEnable;
    }

    public isEnable (): boolean {
        return this._isEnable;
    }

    /**
     * Get the hosting node of this camera
     * @returns {Node} the hosting node
     */
    get node (): Node | null {
        return this._node;
    }

    /**
     * Set the hosting node of this model
     * @param {Node} node the hosting node
     */
    set node (node: Node | null) {
        this._node = node;
    }

    get worldBounds (): aabb {
        return this._worldBounds;
    }
    get modelBounds (): aabb {
        return this._modelBounds;
    }

    get viewID (): number {
        return this._viewID;
    }

    public setSubModel (idx: number, subMeshData: IRenderingSubmesh, mat: Material) {
        if (this._subModels[idx] == null) {
            this._subModels[idx] = _subMeshPool.add();
        } else {
            const oldMat = this._subModels[idx].material;
            this._subModels[idx].destroy();
            this.releasePSO(oldMat);
        }
        this.allocatePSO(mat);
        this._subModels[idx].initialize(subMeshData, mat, this._matPSORecord.get(mat)!);
    }

    public setSubModelMaterial (idx: number, mat: Material) {
        if (this._subModels[idx] == null) {
            return;
        }
        if (this._subModels[idx].material === mat) {
            this.destroyPipelineState(mat, this._matPSORecord.get(mat)!);
            this._matPSORecord.set(mat, this.createPipelineState(mat));
        } else {
            this.releasePSO(this._subModels[idx].material);
            this.allocatePSO(mat);
        }
        this._subModels[idx].material = mat;
        this._subModels[idx].psos = this._matPSORecord.get(mat)!;
    }

    protected createPipelineState (mat: Material): GFXPipelineState[] {
        const ret = new Array<GFXPipelineState>(mat.passes.length);
        for (let i = 0; i < ret.length; i++) {
            ret[i] = mat.passes[i].createPipelineState()!;
            ret[i].pipelineLayout.layouts[0].bindBuffer(UBOLocal.BLOCK.binding, this.localUBO);
        }
        return ret;
    }

    protected destroyPipelineState (mat: Material, pso: GFXPipelineState[]) {
        for (let i = 0; i < mat.passes.length; i++) {
            mat.passes[i].destroyPipelineState(pso[i]);
        }
    }

    private allocatePSO (mat: Material) {
        if (this._matRefCount.get(mat) == null) {
            this._matRefCount.set(mat, 1);
            this._matPSORecord.set(mat, this.createPipelineState(mat));
        } else {
            this._matRefCount.set(mat, this._matRefCount.get(mat)! + 1);
        }
    }

    private releasePSO (mat: Material) {
        this._matRefCount.set(mat, this._matRefCount.get(mat)! - 1);
        if (this._matRefCount.get(mat) === 0) {
            this.destroyPipelineState(mat, this._matPSORecord.get(mat)!);
            this._matPSORecord.delete(mat);
            this._matRefCount.delete(mat);
        }
    }

    /**
     * Set the user key
     * @param {number} key
     */
    set userKey (key: number) {
        this._userKey = key;
    }

    get uboLocal (): UBOLocal {
        return this._uboLocal;
    }

    get localUBO (): GFXBuffer {
        return this._localUBO!;
    }
}
