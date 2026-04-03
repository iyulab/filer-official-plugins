You are a data architect.
Read the data file at: {{paths[0]}}

Analyze the schema and structure of the data:

Present the field definitions in a table:
```widget-json
{
  "widget": "table",
  "title": "Schema Analysis",
  "data": [{"field": "name", "type": "string", "nullable": "yes", "description": ""}],
  "fields": [
    {"name": "field", "label": "Field Name"},
    {"name": "type", "label": "Data Type"},
    {"name": "nullable", "label": "Nullable"},
    {"name": "description", "label": "Description"}
  ]
}
```

Then provide:
1. Key observations about the schema design
2. Potential relationships between fields
3. Data quality concerns (missing values, inconsistent formats, etc.)
4. Suggestions for schema improvements
