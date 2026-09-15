# coding: utf-8
"""TEST-MIP-VOI-SLAB-DOM: the MIP Viewer VOI Slab cases authored in test_volume_mip.py, on their own bounded hosted runner."""
import unittest
from test_volume_mip import VOI_SLAB_CASES,VolumeMipE2E

# scripts/run-tests.py accepts only cases whose class is declared in the selected module, so this subclass carries the
# authored VolumeMipE2E cases unchanged. It declares no case itself and selects each VOI Slab case exactly once; the
# inherited MIP Viewer, projection, job and orientation cases stay out.
class VolumeMipVoiE2E(VolumeMipE2E):pass

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeMipVoiE2E(n) for n in VOI_SLAB_CASES)
if __name__=='__main__':unittest.main(verbosity=2)
