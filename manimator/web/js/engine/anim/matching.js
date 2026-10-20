// TransformMatchingShapes and TransformMatchingTex: a port of manim/animation/transform_matching_parts.py.
//
// Manim walks the matching keys in Python set order, which differs between runs (string and bytes hashes are
// randomised per process); here they go in the order the parts come. Only the order the pieces are drawn in among
// themselves can differ.

import { Group } from "../manim/mobject.js";
import { MathTexPart } from "../manim/tex.js";
import { VGroup, VMobject } from "../manim/vmobject.js";
import { AnimationGroup } from "./composition.js";
import { FadeIn, FadeOut } from "./fading.js";
import { FadeTransformPieces, Transform } from "./transform.js";

/** numpy's round(x, 3) (round half to even of x * 1000), with -0.0 made 0.0 */
function round3(x) {
  const y = x * 1000;
  let r = Math.round(y);
  if (Math.abs(y % 1) === 0.5 && r % 2 !== 0) r -= 1;
  return r / 1000 + 0.0;
}

class TransformMatchingAbstractBase extends AnimationGroup {
  static SIG = ["mobject", "target_mobject", "transform_mismatches", "fade_transform_mismatches", "key_map"];

  __init__({ mobject, target_mobject, transform_mismatches = false, fade_transform_mismatches = false, key_map = null,
    ...kw } = {}) {
    const GroupType = mobject instanceof VMobject ? VGroup : Group;
    const sourceMap = this.get_shape_map(mobject);
    const targetMap = this.get_shape_map(target_mobject);
    const keyMap = key_map ?? {};
    const transformSource = GroupType.make();
    const transformTarget = GroupType.make();
    for (const key of sourceMap.keys()) {
      if (!targetMap.has(key)) continue;
      transformSource.add(sourceMap.get(key));
      transformTarget.add(targetMap.get(key));
    }
    const anims = [Transform.make({ ...kw, mobject: transformSource, target_mobject: transformTarget })];
    const keyMappedSource = GroupType.make();
    const keyMappedTarget = GroupType.make();
    for (const [key1, key2] of Object.entries(keyMap)) {
      if (sourceMap.has(key1) && targetMap.has(key2)) {
        keyMappedSource.add(sourceMap.get(key1));
        keyMappedTarget.add(targetMap.get(key2));
        sourceMap.delete(key1);
        targetMap.delete(key2);
      }
    }
    if (keyMappedSource.__len__() > 0) {
      anims.push(FadeTransformPieces.make({ ...kw, mobject: keyMappedSource, target_mobject: keyMappedTarget }));
    }
    const fadeSource = GroupType.make();
    const fadeTarget = GroupType.make();
    for (const key of sourceMap.keys()) if (!targetMap.has(key)) fadeSource.add(sourceMap.get(key));
    for (const key of targetMap.keys()) if (!sourceMap.has(key)) fadeTarget.add(targetMap.get(key));
    const fadeTargetCopy = fadeTarget.copy();
    if (transform_mismatches) {
      const tkw = { ...kw };
      if (!("replace_mobject_with_target_in_scene" in tkw)) tkw.replace_mobject_with_target_in_scene = true;
      anims.push(Transform.make({ ...tkw, mobject: fadeSource, target_mobject: fadeTarget }));
    } else if (fade_transform_mismatches) {
      anims.push(FadeTransformPieces.make({ ...kw, mobject: fadeSource, target_mobject: fadeTarget }));
    } else {
      anims.push(FadeOut.make({ ...kw, mobjects: [fadeSource], target_position: fadeTarget }));
      anims.push(FadeIn.make({ ...kw, mobjects: [fadeTargetCopy], target_position: fadeTarget }));
    }
    super.__init__({ animations: anims });
    this.to_remove = [mobject, fadeTargetCopy];
    this.to_add = target_mobject;
    return this;
  }

  get_shape_map(mobject) {
    const map = new Map();
    for (const sm of this.constructor.get_mobject_parts(mobject)) {
      const key = this.constructor.get_mobject_key(sm);
      if (!map.has(key)) map.set(key, VGroup.make());
      map.get(key).add(sm);
    }
    return map;
  }

  clean_up_from_scene(scene) {
    for (const anim of this.animations) anim.interpolate(0);
    scene.remove(this.mobject);
    scene.remove(...this.to_remove);
    scene.add(this.to_add);
  }
}

export class TransformMatchingShapes extends TransformMatchingAbstractBase {
  static get_mobject_parts(mobject) {
    return mobject.family_members_with_points();
  }

  static get_mobject_key(mobject) {
    mobject.save_state();
    mobject.center();
    mobject.set({ height: 1 });
    const key = mobject.points.map((p) => p.map(round3).join(",")).join(";");
    mobject.restore();
    return key;
  }
}

export class TransformMatchingTex extends TransformMatchingAbstractBase {
  static get_mobject_parts(mobject) {
    if (mobject instanceof Group || mobject instanceof VGroup) {
      return mobject.submobjects.flatMap((s) => TransformMatchingTex.get_mobject_parts(s));
    }
    if (!("tex_string" in mobject)) throw new Error("TransformMatchingTex needs formulas");
    return mobject.submobjects;
  }

  static get_mobject_key(mobject) {
    if (!(mobject instanceof MathTexPart)) throw new Error("TransformMatchingTex needs the parts of a MathTex");
    return mobject.tex_string;
  }
}

