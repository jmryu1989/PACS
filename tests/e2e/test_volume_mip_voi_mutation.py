# coding: utf-8
"""A11-VOI-1 mutation experiments only: one authored VOI Slab case (N1 or N2) per hosted run, never a candidate gate."""
import os,unittest
from test_volume_mip import VOI_SLAB_CASES,VolumeMipE2E

# The same pattern as test_volume_mip_voi.py: scripts/run-tests.py accepts only cases whose class is declared in the selected
# module, so this subclass carries the authored cases unchanged and declares none. tests/voi_mutations/harness.py names the
# variant's case before measurement_ci.py starts; an unset or unknown name refuses instead of widening the selection.
CASES={'N1':'test_mip_04_voi_slab_known_voxels_modes_orientations','N2':'test_mip_05_voi_order_delay_failure_missing_tool_cancel'}
if not all(name in VOI_SLAB_CASES for name in CASES.values()):raise RuntimeError('Authored VOI Slab cases changed')
class VolumeMipVoiMutationE2E(VolumeMipE2E):pass

def load_tests(loader,tests,pattern):return unittest.TestSuite([VolumeMipVoiMutationE2E(CASES[os.environ['KIN_VOI_MUTATION_CASE']])])
