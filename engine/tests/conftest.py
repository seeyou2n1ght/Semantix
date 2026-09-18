import os
import sys

# Ensure pytest runs in deterministic testing mode
os.environ["SEMANTIX_TESTING"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
