# taurusmq/benchmarks/generate_endurance_charts.py
import json
import os
import matplotlib.pyplot as plt

# Set styling
plt.style.use('seaborn-v0_8-whitegrid' if 'seaborn-v0_8-whitegrid' in plt.style.available else 'default')
plt.rcParams['font.sans-serif'] = 'Arial'
plt.rcParams['font.family'] = 'sans-serif'
plt.rcParams['text.color'] = '#2c3e50'
plt.rcParams['axes.labelcolor'] = '#2c3e50'
plt.rcParams['xtick.color'] = '#2c3e50'
plt.rcParams['ytick.color'] = '#2c3e50'

# Load data
base_dir = os.path.dirname(os.path.abspath(__file__))
report_path = os.path.join(base_dir, 'raw', 'endurance-results.json')

if not os.path.exists(report_path):
    print(f"Error: {report_path} not found. Run the endurance test first.")
    exit(1)

with open(report_path) as f:
    data = json.load(f)

timeline = data['timeline']
times = [entry['seconds'] / 60.0 for entry in timeline] # convert to minutes
rss = [entry['rss'] for entry in timeline]
heap = [entry['heap'] for entry in timeline]
throughput = [entry['throughput'] for entry in timeline]

charts_dir = os.path.join(base_dir, 'charts')
os.makedirs(charts_dir, exist_ok=True)

# Chart 1: Memory Footprint Over Time
plt.figure(figsize=(8, 5))
plt.plot(times, rss, color='#e74c3c', linewidth=2.5, label='RSS Memory (Physical)')
plt.plot(times, heap, color='#3498db', linewidth=2, linestyle='--', label='V8 Heap Used')
plt.title('Memory Footprint Stability (Zero Leak Validation)', fontsize=14, fontweight='bold', pad=15)
plt.xlabel('Elapsed Time (minutes)', fontsize=12)
plt.ylabel('Memory Usage (MB)', fontsize=12)
plt.ylim(0, max(rss) * 1.3)
plt.legend(frameon=True, facecolor='white', edgecolor='#e2e8f0')
plt.tight_layout()
plt.savefig(os.path.join(charts_dir, 'endurance_memory.png'), dpi=300)
plt.close()

# Chart 2: Throughput Stability Over Time
plt.figure(figsize=(8, 5))
plt.plot(times, throughput, color='#2ecc71', linewidth=2.5, label='Throughput')
# Add average line
avg_tp = data['avgThroughput']
plt.axhline(y=avg_tp, color='#27ae60', linestyle=':', label=f'Average ({avg_tp:.0f} jobs/s)')

plt.title('Throughput Stability (No Degradation Validation)', fontsize=14, fontweight='bold', pad=15)
plt.xlabel('Elapsed Time (minutes)', fontsize=12)
plt.ylabel('Throughput (jobs/sec)', fontsize=12)
plt.ylim(0, max(throughput) * 1.3)
plt.legend(frameon=True, facecolor='white', edgecolor='#e2e8f0')
plt.tight_layout()
plt.savefig(os.path.join(charts_dir, 'endurance_throughput.png'), dpi=300)
plt.close()

print('Endurance charts successfully generated and saved inside taurusmq/benchmarks/charts/')
