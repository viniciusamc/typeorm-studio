process.stdout.write('stdout line before failing\n');
process.stderr.write('Error: boom while loading the data source\n');
process.exitCode = 3;
