"""Constraint tests include an independent critical-time oracle."""
import copy
from fractions import Fraction as F
import itertools
import json
import random
import unittest

from kinetyl import (InvalidPlan, InvalidScene, NoSolution, SearchBudgetExceeded,
                     compile_scene, validate_intent, validate_scene, verify_plan)
from kinetyl.core import _Budget, _overlap, scene_identity


def scene(count=2, portrait=False):
    nodes = []
    for i in range(count):
        start, end = (-2, 2) if i % 2 == 0 else (2, -2)
        nodes.append({"id": "node"+str(i), "text": "Label "+str(i), "font_size": 28,
                      "color": "#abcdef", "radius": "3/20", "keyframes": [[0,start,0],[3,end,0]],
                      "envelope": {"width": "11/5", "height": "2/5", "measurement": {
                          "engine": "declared-test", "version": "1", "font": "test"}, "glyph_paths": []}})
    return {"schema": "kinetyl-scene/1", "duration": 3, "nodes": nodes,
            "export": {"width": 720 if portrait else 1280, "height": 1280 if portrait else 720,
                       "frame_rate": 24, "frame_height": 8}, "margin": "1/10",
            "camera_scales": [1,"4/5","3/5","2/5"], "min_font_size": 24}


def at(track,t):
    for a,b in zip(track,track[1:]):
        if a[0]<=t<=b[0]:
            return tuple(a[k]+(t-a[0])*(b[k]-a[k])/(b[0]-a[0]) for k in (1,2))
    raise ValueError("outside")


def hits(a,ha,oa,b,hb,ob,g,t):
    aa,bb=at(a,t),at(b,t)
    return all(abs(aa[k]+oa[k]-bb[k]-ob[k])<ha[k]+hb[k]+g for k in (0,1))


def oracle(a,ha,oa,b,hb,ob,g):
    cuts=sorted({p[0] for p in a+b}); critical=set(cuts)
    for start,end in zip(cuts,cuts[1:]):
        aa,bb,ae,be=at(a,start),at(b,start),at(a,end),at(b,end)
        for k in (0,1):
            x=aa[k]+oa[k]-bb[k]-ob[k]; y=ae[k]+oa[k]-be[k]-ob[k]
            if x==y:continue
            for bound in (ha[k]+hb[k]+g,-ha[k]-hb[k]-g):
                t=start+(bound-x)*(end-start)/(y-x)
                if start<=t<=end:critical.add(t)
    critical=sorted(critical)
    return next((t for t in critical+[(x+y)/2 for x,y in zip(critical,critical[1:])] if hits(a,ha,oa,b,hb,ob,g,t)),None)


class CoreTests(unittest.TestCase):
    def test_crossing_missed_by_endpoints_is_repaired(self):
        source=scene();plan=compile_scene(source)
        self.assertEqual(plan["layout"]["camera_scale"],"1")
        self.assertNotEqual(plan["layout"]["offsets"][0]["y"],plan["layout"]["offsets"][1]["y"])
        self.assertTrue(verify_plan(json.loads(json.dumps(plan)))["valid"])

    def test_portrait_camera_preserves_world_paths_and_font(self):
        source=scene(portrait=True);plan=compile_scene(source)
        self.assertEqual(plan["layout"]["camera_scale"],"2/5")
        self.assertEqual(plan["scene"],validate_scene(source))
        for old,new in zip(source["nodes"],plan["scene"]["nodes"]):self.assertEqual(old["font_size"],new["font_size"])
        self.assertEqual(plan["layout"]["projected_tracks"][0]["keyframes"],[['0','-4/5','0'],['3','4/5','0']])

    def test_many_keyframe_times_and_three_nodes(self):
        source=scene(3)
        source["nodes"][1]["keyframes"]=[[0,2,0],[1,0,0],[3,-2,0]]
        source["nodes"][2]["keyframes"]=[[0,-1,2],[2,1,2],[3,-1,2]]
        for n in source["nodes"]:n["envelope"]["width"]="1"
        plan=compile_scene(source)
        self.assertEqual(verify_plan(plan)["checks"],{"label_pair_checks":3,"label_dot_checks":9,"viewport_checks":6})

    def test_declared_family_impossible_and_budget_inconclusive_differ(self):
        source=scene(1,portrait=True);source["nodes"][0]["envelope"]["width"]="8"
        with self.assertRaises(NoSolution):compile_scene(source)
        with self.assertRaises(SearchBudgetExceeded):compile_scene(source,work_budget=1)
        with self.assertRaises(SearchBudgetExceeded):compile_scene(scene(),work_budget=20)

    def test_dot_cannot_be_clipped_to_fit_label(self):
        source=scene(1,portrait=True);source["nodes"][0]["keyframes"]=[[0,3,0],[3,3,0]]
        source["nodes"][0]["envelope"]["width"]="2"
        plan=compile_scene(source)
        self.assertLessEqual(F(plan["layout"]["camera_scale"])*3+F("3/20"),F("9/4"))

    def test_normalization_detaches_and_preserves_supplied_float(self):
        source=scene(1);source["nodes"][0]["keyframes"][0][1]=0.1
        normalized=validate_scene(source)
        self.assertEqual(F(normalized["nodes"][0]["keyframes"][0][1]),F.from_float(0.1))
        source["nodes"][0]["text"]="changed"
        self.assertEqual(normalized["nodes"][0]["text"],"Label 0")
        self.assertEqual(normalized["nodes"][0]["color"],"#ABCDEF")

    def test_intent_does_not_invent_measurements(self):
        intent=scene(1);intent["schema"]="kinetyl-intent/1";del intent["nodes"][0]["envelope"]
        self.assertNotIn("envelope",validate_intent(intent)["nodes"][0])
        with self.assertRaises(InvalidScene):validate_scene(intent)
        intent["nodes"][0]["envelope"]={}
        with self.assertRaises(InvalidScene):validate_intent(intent)

    def test_shapes_ranges_unicode_and_identity_are_strict(self):
        alterations=[lambda s:s.update(extra=1),lambda s:s.update(duration=True),lambda s:s.update(duration=float('nan')),
                     lambda s:s.update(margin="1/0"),lambda s:s.update(margin="1e999999"),
                     lambda s:s.update(camera_scales=[1,1]),lambda s:s.update(nodes=[]),
                     lambda s:s["nodes"][0].update(text="bad\ud800"),lambda s:s["nodes"][0].update(text="bad\x00"),
                     lambda s:s["nodes"][0].update(color="javascript:x"),lambda s:s["nodes"][0].update(id="node1"),
                     lambda s:s["nodes"][0].update(keyframes=[[1,0,0],[3,0,0]]),
                     lambda s:s["nodes"][0].update(keyframes=[[0,0,0],[0,1,0],[3,0,0]]),
                     lambda s:s["nodes"][0].update(keyframes=[[0,0,0]]),lambda s:s["nodes"][0].update(radius=float('inf')),
                     lambda s:s["nodes"][0]["envelope"].update(width=0),lambda s:s["export"].update(frame_height=9)]
        for mutate in alterations:
            with self.subTest(mutate=mutate):
                data=scene();mutate(data)
                with self.assertRaises(InvalidScene):validate_scene(data)

    def test_rational_bit_and_magnitude_limits(self):
        for value in ("1/"+str(2**257),str(2**257),10001):
            source=scene();source["nodes"][0]["keyframes"][0][1]=value
            with self.assertRaises(InvalidScene):validate_scene(source)

    def test_vector_paths_are_data_and_inside_envelope(self):
        source=scene(1);source["nodes"][0]["envelope"]["glyph_paths"]=[[['M',0,0],['Q','1/10',0,0,'1/10'],['Z']]]
        self.assertEqual(validate_scene(source)["nodes"][0]["envelope"]["glyph_paths"][0][0],['M','0','0'])
        for commands in ([[['svg','<script>']]],[[['L',0,0]]],[[['M',0,0],['Z'],['L',0,0]]],[[['M',10,0]]]):
            source["nodes"][0]["envelope"]["glyph_paths"]=commands
            with self.assertRaises(InvalidScene):validate_scene(source)

    def test_forged_plan_fields_and_counts_reject(self):
        plan=compile_scene(scene())
        changes=[lambda p:p.update(input_sha256="0"*64),lambda p:p.update(success=True),
                 lambda p:p["verification"].update(label_pair_checks=True),lambda p:p["verification"].update(scope="pixels proven"),
                 lambda p:p["layout"].update(camera_scale="1/3"),lambda p:p["layout"].update(offsets=[]),
                 lambda p:p["layout"]["offsets"][0].update(node_id="node1"),
                 lambda p:p["layout"]["projected_tracks"][0]["keyframes"][0].__setitem__(1,"0"),
                 lambda p:p["layout"]["viewport"].update(half_width="999"),
                 lambda p:p["layout"].update(projected_tracks=[{}]*9),
                 lambda p:p["scene"]["nodes"][0].update(text="modified")]
        for change in changes:
            with self.subTest(change=change):
                forged=copy.deepcopy(plan);change(forged)
                with self.assertRaises(InvalidPlan):verify_plan(forged)

    def test_legal_slots_can_still_forge_a_continuous_conflict(self):
        forged=compile_scene(scene())
        forged["layout"]["offsets"][1]["y"]=forged["layout"]["offsets"][0]["y"]
        with self.assertRaisesRegex(InvalidPlan,"label-label"):verify_plan(forged)

    def test_derived_offset_rationals_can_exceed_input_bit_limit(self):
        source=scene(1);node=source["nodes"][0]
        node["keyframes"]=[[0,0,0],[3,0,0]]
        node["radius"]="1/"+str(2**251-19)
        source["margin"]="1/"+str(2**251-35)
        node["envelope"]["height"]="1/"+str(2**251-9)
        plan=compile_scene(source)
        self.assertGreater(F(plan["layout"]["offsets"][0]["y"]).denominator.bit_length(),256)
        self.assertTrue(verify_plan(plan)["valid"])

    def test_exact_contact_is_safe_open_crossing_is_not(self):
        a=[(F(0),F(0),F(0)),(F(3),F(0),F(0))];h=(F(1),F(1));z=(F(0),F(0))
        self.assertIsNone(_overlap(a,h,z,a,h,(F('21/10'),F(0)),F('1/10'),_Budget(1000)))
        b=[(F(0),F(-2),F(0)),(F(3),F(2),F(0))]
        witness=_overlap(a,h,z,b,h,z,F(0),_Budget(1000))
        self.assertTrue(hits(a,h,z,b,h,z,F(0),witness))
        corner=[(F(0),F(1),F(3)),(F(3),F(3),F(1))]
        self.assertIsNone(_overlap(a,h,z,corner,h,z,F(0),_Budget(1000)))

    def test_exact_overlap_against_independent_critical_time_oracle(self):
        rng=random.Random(5739)
        def track():
            times=sorted({F(0),F(3)}|set(rng.sample([F(i,4) for i in range(1,12)],rng.randrange(5))))
            return [(t,F(rng.randrange(-12,13),3),F(rng.randrange(-12,13),3)) for t in times]
        for _ in range(400):
            a,b=track(),track();ha=tuple(F(rng.randrange(1,10),5) for _ in range(2));hb=tuple(F(rng.randrange(1,10),5) for _ in range(2))
            oa=tuple(F(rng.randrange(-5,6),4) for _ in range(2));ob=tuple(F(rng.randrange(-5,6),4) for _ in range(2));gap=F(rng.randrange(4),10)
            expected=oracle(a,ha,oa,b,hb,ob,gap);actual=_overlap(a,ha,oa,b,hb,ob,gap,_Budget(1000))
            self.assertEqual(expected is None,actual is None)
            if actual is not None:self.assertTrue(hits(a,ha,oa,b,hb,ob,gap,actual))


if __name__=="__main__":unittest.main()
