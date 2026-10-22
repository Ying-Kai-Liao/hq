"""Old name of kith_settings.py, kept for agent role repos that import it."""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from kith_settings import *  # noqa: E402,F401,F403

if __name__ == '__main__':
    import runpy
    runpy.run_module('kith_settings', run_name='__main__')
