#!/usr/bin/env bash                                                                                                                                                                                                    
python3 - "$1" << 'EOF'
import sys                                                                                                                                                                                                             
depth = 0                                                                                                                                                                                                              
with open(sys.argv[1]) as f:
	for lineno, line in enumerate(f, 1):
		for ch in line:
			if ch == '{': depth += 1
			elif ch == '}': depth -= 1                                                                                                                                                                                 
		if depth != 0:
			print(f'Brace imbalance after line {lineno}: depth={depth}')                                                                                                                                               
			depth = 0
EOF

