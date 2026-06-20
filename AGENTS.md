# Read Permission Gate

## What is it ?
This project is a [pi](https://pi.dev/) extension, which enables running tool calls in a safe manner. It whitelists safe commands while asking permissions for potentially unsafe commands.

## Useful Commands

1. Installing the pacakge:
```
pi install ./
```
Note: The user has to restart pi or use `/reload` for the changse to take effect

2. Tests:
```
npm run test
```

3. Format and lint
```
npm run verify
```

## Project stucture and coding Guidelines

- The source code for the extension is inside `/src` and the tests are inside `/tests`
- Write useful comments for each functions describing what they do
- Write declarative code with descriptive function and variable names which is easy for an human to understand.

## Development Instructions

You should follow the following steps while developing any feature

1. First add/update the unit tests for this behavior
2. Then implement the code
3. Run the formatter
4. Run the test suit
5. Fix any failures, and rerun step 3 and 4. Unti there aren't any more failures
6. Give a report on what you changed once you are done.

