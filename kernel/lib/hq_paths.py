"""Old name of kith_paths.py, kept for agent role repos that import it (tools/*.py: `from hq_paths import paths`).
paths() returns both spellings of every key: KITH_HOME and HQ_HOME, KITH_MACHINE and HQ_MACHINE, ..."""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from kith_paths import *  # noqa: E402,F401,F403
from kith_paths import paths as _paths, with_old_names  # noqa: E402


def paths():
    return with_old_names(_paths())
