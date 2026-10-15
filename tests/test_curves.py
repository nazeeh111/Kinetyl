"""Cubic geometry checks with factored and de Casteljau reference oracles."""
import copy
from fractions import Fraction as F
import json
from pathlib import Path
import random
import unittest

from kinetyl import compile_scene, validate_scene, verify_plan, InvalidScene, InvalidPlan, SearchBudgetExceeded
from kinetyl.core import _Budget, _CurveTrack, _overlap, _inside, _point
from kinetyl import polynomial as p
from kinetyl.manimgx_adapter import _point as native_point
from test_core import scene


def cubic_scene():
    s = scene()
    s['schema'] = 'kinetyl-scene/2'
    s['nodes'][0]['keyframes'] = [[0, -2, -1], [3, 2, -1]]
    s['nodes'][1]['keyframes'] = [[0, 2, 1], [3, -2, 1]]
    s['nodes'][0]['controls'] = [[-2, 2, 2, 2]]
    s['nodes'][1]['controls'] = [[2, -2, -2, -2]]
    for n in s['nodes']:
        n['envelope']['width'] = '1'
    return s


class PolynomialTests(unittest.TestCase):
    def test_factored_oracle(self):
        rng = random.Random(20261015)
        for _ in range(700):
            roots, ps = [], []
            for _ in range(rng.randrange(1, 5)):
                poly = (F(rng.choice([-1, 1])),)
                for _ in range(rng.randrange(1, 4)):
                    r = F(rng.randrange(-2, 9), rng.choice([3, 7, 11, 101]))
                    roots.append(r)
                    poly = p.multiply(poly, (-r, F(1)), _Budget(10000))
                ps.append(poly)
            # Oracle knows generating roots, independently of Sturm isolation.
            cuts = sorted({F(0), F(1), *(r for r in roots if 0 < r < 1)})
            expected = any(all(p.evaluate(poly, (a+b)/2) < 0 for poly in ps) for a, b in zip(cuts, cuts[1:]))
            t = p.negative_witness(ps, F(0), F(1), _Budget(100000))
            self.assertEqual(t is not None, expected)
            if t is not None:
                self.assertTrue(0 <= t <= 1 and all(p.evaluate(poly, t) < 0 for poly in ps))

    def test_irrational_boundaries_and_tangency(self):
        for ps, expected in [([(-2, 0, 1), (F(7, 5), -1)], True),
                             ([(-2, 0, 1), (F(3, 2), -1)], False),
                             ([(F(1, 4), -1, 1)], False),
                             ([(-F(1, 2), 1), (F(1, 2), -1)], False)]:
            t = p.negative_witness(ps, F(0), F(2), _Budget(100000))
            self.assertEqual(t is not None, expected)

    def test_arithmetic_and_work_limits_are_inconclusive(self):
        with self.assertRaises(SearchBudgetExceeded):
            p.negative_witness([(1, -4, 4)], F(0), F(1), _Budget(1))
        with self.assertRaises(p.PolynomialLimit):
            p.negative_witness([(F(1, 2**16385), -1)], F(0), F(1), _Budget(100000))


class CubicTests(unittest.TestCase):
    def test_scene_compile_verify_and_roundtrip(self):
        source = cubic_scene()
        plan = compile_scene(source, work_budget=1000000)
        self.assertEqual(plan['schema'], 'kinetyl-plan/2')
        self.assertEqual(plan['scene'], validate_scene(source))
        self.assertTrue(verify_plan(json.loads(json.dumps(plan)))['valid'])
        self.assertIn('piecewise-cubic', plan['verification']['scope'])
        self.assertEqual(plan['layout']['projected_tracks'][0]['controls'], [['-2', '2', '2', '2']])

    def test_control_validation_and_plan_tampering(self):
        for value in ([], [[0, 0, 0]], [[0, 0, 0, True]], [[0, 0, 0, '10001']], [[0, 0, 0, '1/0']]):
            source = cubic_scene()
            source['nodes'][0]['controls'] = value
            with self.assertRaises(InvalidScene):
                validate_scene(source)
        plan = compile_scene(cubic_scene(), work_budget=1000000)
        for mutate in (lambda x: x.update(schema='kinetyl-plan/1'),
                       lambda x: x['layout']['projected_tracks'][0]['controls'][0].__setitem__(0, '0'),
                       lambda x: x['layout']['projected_tracks'][0]['controls'][0].__setitem__(0, 0),
                       lambda x: x['verification'].update(scope='pixels proved')):
            bad = copy.deepcopy(plan)
            mutate(bad)
            with self.assertRaises(InvalidPlan):
                verify_plan(bad)

    def test_curved_viewport_excursion_between_endpoints(self):
        track = _CurveTrack([(F(0), F(0), F(0)), (F(1), F(0), F(0))], [(F(10), F(0), F(10), F(0))])
        z = (F(0), F(0))
        self.assertFalse(_inside(track, z, z, (F(7), F(4)), _Budget(100000)))
        # A control hull outside the viewport does not prove the curve clips.
        self.assertTrue(_inside(track, z, z, (F(15, 2), F(4)), _Budget(100000)))

    def test_subframe_conflict_is_not_a_sampled_claim(self):
        c, e = F(1, 121), F(1, 10**7)
        track = _CurveTrack([(F(0), c*c, F(0)), (F(1), (1-c)**2, F(0))],
                            [(c*c-2*c/3, F(0), c*c-4*c/3+F(1, 3), F(0))])
        fixed = [(F(0), F(0), F(0)), (F(1), F(0), F(0))]
        half, z = (e*e/2, F(1, 2)), (F(0), F(0))
        t = _overlap(track, half, z, fixed, half, z, F(0), _Budget(100000))
        self.assertIsNotNone(t)
        self.assertLess(abs(t-c), e)
        self.assertTrue(all((F(i, 60)-c)**2 >= e*e for i in range(61)))

    def test_independent_native_de_casteljau_matches_exact_kernel(self):
        source = cubic_scene()
        # Give each object a different segment boundary, exercising restriction.
        n = source['nodes'][1]
        n['keyframes'] = [[0, 2, 1], [1, 0, -1], [3, -2, 1]]
        n['controls'] = [[2, 0, 1, -1], [-1, -1, -2, 0]]
        for node in validate_scene(source)['nodes']:
            frames = [tuple(map(F, f)) for f in node['keyframes']]
            track = _CurveTrack(frames, [tuple(map(F, c)) for c in node['controls']])
            for i in range(121):
                time = F(i, 40)
                self.assertEqual(_point(track, time), native_point(node['keyframes'], time, node['controls']))

    def test_v1_examples_stay_byte_identical_after_recompile(self):
        root = Path(__file__).parents[1]/'src/kinetyl/examples'
        for file in root.glob('*.plan.json'):
            stored = json.loads(file.read_text())
            if stored['schema'] == 'kinetyl-plan/1':
                self.assertEqual(compile_scene(stored['scene']), stored)


if __name__ == '__main__':
    unittest.main()
