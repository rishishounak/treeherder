import React from 'react';
import { hot } from 'react-hot-loader/root';

import UserGuideHeader from './UserGuideHeader';
import UserGuideBody from './UserGuideBody';
import UserGuideFooter from './UserGuideFooter';

import '../css/treeherder-userguide.css';
import '../css/treeherder-job-buttons.css';
import '../css/treeherder-base.css';

const App = () => (
  <div id="userguide">
    <div className="card">
      <UserGuideHeader />
      <UserGuideBody />
      <UserGuideFooter />
    </div>
  </div>
);

export default hot(App);
