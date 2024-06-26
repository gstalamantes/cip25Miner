Kupo-CIP25 Miner

A script for pushing metadata from Kupo index matches to a SQL db.
------------------------------------------------------------------

Requirements:

1. A fully synced Cardano node or access to one.  Local nodes are preferred
   due to data sizes, which vary based upon match criteria.  If you are unsure where
   to start, Ogmios via Docker is recommended, as it is highly automated.  See below
   for more info.
   https://ogmios.dev/getting-started/docker/

3. An instance of Kupo, with the index completed.  The match criteria
   will dictate which transactions will be included in the matches.
   Again, Docker is recommended, and provides an image to get you up
   quickly.
   https://hub.docker.com/r/cardanosolutions/kupo

5. An SQL server configured with the proper schema/table.  A MySQL model file
   is provided to create the needed table.  Character format is vital,
   as many assets use EMOJIs!  (utf8mb4/utf8mb4_unicode_ci).
   MySQL Community Edition can be downloaded free from Oracle.
   https://dev.mysql.com/downloads/

----------------------------------------------------------------------

Setup:

First, open a terminal window to clone the repo folder, then change directories to the repo folder.

```git clone https://github.com/gstalamantes/cip25Miner.git```

```cd cip25Miner```

Install the dependencies.

```npm i```

After the dependencies install, run the script by executing the following:

```node metadata.js```
 
The script will pull the matches based on the pattern set on the Kupo index. 
This is not set by default, and must be defined. To index for all CIP25 
tokens, as the project's title implies, use the match criteria "{721}".  
For example, an instance running Kupo via Docker (recommended) that indexes
all 721 tagged tokens would be the following:

```docker run -p 1442:1442 -it --name containerNameHere -v $PWD/dbFolderName:/db  cardanosolutions/kupo:v2.8.0 --ogmios-host ogmiosIpAddress --ogmios-port 1337 --since 23068793.69c44ac1dda2ec74646e4223bc804d9126f719b1c245dadc2ad65e8de1b276d7 --match '{721}' --workdir /db --host 0.0.0.0 --port 1442```

Consult Kupo documentation for all the ways Kupo can be used to index the blockchain below:
https://cardanosolutions.github.io/kupo/


The script can be interrupted and resumed, and should not produce duplicate entries, and after completed, will rescan for new matches every 15 minutes.  This can be altered to your needs.
