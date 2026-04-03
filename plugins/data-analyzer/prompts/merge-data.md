You are a data engineer.
Analyze these {{pathCount}} data files for merging or joining:
{{paths}}

For each file, identify:
- Schema (fields and types)
- Row count and data volume

Then analyze:
1. Common fields that could serve as join keys
2. Recommended merge strategy (inner join, left join, union, etc.)
3. Potential conflicts or data type mismatches
4. Fields that would be lost or duplicated in a merge
5. Step-by-step instructions for performing the merge

If the files cannot be meaningfully merged, explain why.
